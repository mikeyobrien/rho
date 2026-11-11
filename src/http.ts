// The daemon's door: HTTP on loopback only. Every API call carries the bearer token; the one
// exception is trading a one-time pairing code for it. State reaches a client as server-sent
// events, each a whole snapshot (view.ts), so a reconnect needs no replay.
//
// A call names its conversation with `?c=<id>`; without it, the first conversation is meant.
import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync, renameSync } from "node:fs";
import { extname, isAbsolute, join, resolve, sep } from "node:path";
import type { MutableModels } from "@earendil-works/pi-ai/models";
import { LiveDoc, type Conversation } from "@earendil-works/pi-durable";
import type { ImageProcessor } from "@earendil-works/pi-durable/tools";
import type { Core } from "./core.ts";
import { context, parseModel } from "./core.ts";
import { answerApproval, Approvals } from "./tools/guard.ts";
import { recordAnswer } from "./answers.ts";
import type { Notifier } from "./notify.ts";
import type { Worker } from "./tools/delegate.ts";
import type { WorkerView } from "./view.ts";
import { releaseView } from "./gate.ts";
import { MAX_PHOTO_BYTES, PhotoRefused, takePhotos } from "./photos.ts";
import { setupOf } from "./providers.ts";
import { entryView, stateView, type StateView } from "./view.ts";

export interface ServerOptions {
	core: Core;
	models: MutableModels;
	dir: string;
	port: number;
	/** The commit this rho runs, when it runs from a git checkout. The release gate reads it. */
	commit?: string;
	/** Scales a photo that is larger than a model takes. Without one, such a photo is refused. */
	images?: ImageProcessor;
	/** How often a live worker's current step is looked at again. Tests change it. */
	workerPollMs?: number;
	/** Told of every change in every one of the person's conversations, so it can notify them. */
	notifier?: Notifier;
	/** How often `release.json` is looked at while a client is connected. Default 2 s. Tests change it. */
	releasePollMs?: number;
	log?: (line: string) => void;
}
export interface Server {
	port: number;
	/** The one-time code a new browser trades for the token. Replaced each time it is used. */
	pairCode(): string;
	stop(): Promise<void>;
}

const MAX_BODY = 256 * 1024;
/** The most a message with photos may weigh, as sent: two full-size photos in base64, or more smaller ones. */
const MAX_UPLOAD = Math.ceil(MAX_PHOTO_BYTES / 3) * 4 * 2 + MAX_BODY;
/** The page's own files. They hold no secrets, so they are served without the token. */
const WEB_ROOT = resolve(import.meta.dir, "..", "web");
const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".png": "image/png", ".svg": "image/svg+xml", ".webmanifest": "application/manifest+json" };
const PAGE_HEADERS = {
	"cache-control": "no-cache",
	// The page runs only its own scripts and styles and talks only to this server.
	"content-security-policy": "default-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
	"x-content-type-options": "nosniff",
	"referrer-policy": "no-referrer",
};
async function pageFile(pathname: string): Promise<Response | undefined> {
	const file = resolve(WEB_ROOT, `.${pathname === "/" ? "/index.html" : pathname}`);
	if (!file.startsWith(WEB_ROOT + sep) || TYPES[extname(file)] === undefined) return undefined;
	const blob = Bun.file(file);
	if (!(await blob.exists())) return undefined;
	return new Response(blob, { headers: { ...PAGE_HEADERS, "content-type": TYPES[extname(file)]! } });
}
const THINKING = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
class Refusal extends Error {
	constructor(readonly status: number, message: string) {
		super(message);
	}
}
const same = (a: string, b: string): boolean => {
	const left = Buffer.from(a);
	const right = Buffer.from(b);
	return left.length === right.length && timingSafeEqual(left, right);
};
const json = (status: number, value: unknown) => Response.json(value, { status, headers: { "cache-control": "no-store" } });

async function bodyOf(request: Request, limit: { bytes: number; chars: number; words: string } = { bytes: MAX_BODY * 4, chars: MAX_BODY, words: "The message is too long." }): Promise<Record<string, unknown>> {
	// Refused by its declared size before it is read; one that declares none is cut off as it is read.
	if (Number(request.headers.get("content-length") ?? 0) > limit.bytes) throw new Refusal(413, limit.words);
	const chunks: Uint8Array[] = [];
	let size = 0;
	for await (const chunk of (request.body ?? []) as AsyncIterable<Uint8Array>) {
		size += chunk.length;
		if (size > limit.bytes) throw new Refusal(413, limit.words);
		chunks.push(chunk);
	}
	const text = Buffer.concat(chunks).toString("utf8");
	if (text.length > limit.chars) throw new Refusal(413, limit.words);
	try {
		const value = JSON.parse(text || "{}") as unknown;
		if (typeof value === "object" && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
	} catch {
		// refused below
	}
	throw new Refusal(400, "The request is not a JSON object.");
}
/** An absolute path to a directory that exists, or a refusal that says which it is not. */
function directory(path: unknown): string {
	if (typeof path !== "string" || !isAbsolute(path)) throw new Refusal(400, "path is an absolute directory.");
	if (!existsSync(path) || !statSync(path).isDirectory()) throw new Refusal(400, "That directory does not exist.");
	return resolve(path);
}

type Stream = ReadableStreamDefaultController<Uint8Array>;
/** One conversation as the server holds it open: its watch, its newest snapshot, its listeners. */
interface Channel {
	id: string;
	conversation: Conversation;
	current: StateView;
	streams: Set<Stream>;
	/** One of the person's own conversations. A worker's thread is not: it is read, never written or notified from. */
	own: boolean;
	/** Read the waiting approvals and the workers again and tell the listeners. */
	refresh(): Promise<void>;
	stop(): Promise<unknown>;
}

export async function serve(options: ServerOptions): Promise<Server> {
	const { core, models, dir } = options;
	const log = options.log ?? (() => {});

	const tokenPath = join(dir, "token");
	// A token file that is empty or cut short (a kill while it was written) is replaced: an empty
	// token would equal a request that sends none.
	const stored = existsSync(tokenPath) ? readFileSync(tokenPath, "utf8").trim() : "";
	if (stored.length < 32) {
		if (stored !== "" || existsSync(tokenPath)) log("token: the stored token was unusable and was replaced. Pair again with: rho open");
		writeFileSync(`${tokenPath}.tmp`, randomBytes(32).toString("base64url"), { mode: 0o600 });
		renameSync(`${tokenPath}.tmp`, tokenPath);
	}
	const token = readFileSync(tokenPath, "utf8").trim();
	if (token.length < 32) throw new Error(`The token in ${tokenPath} could not be written.`);
	let pairCode = randomBytes(16).toString("base64url");
	const savePairCode = () => writeFileSync(join(dir, "pair-code"), pairCode, { mode: 0o600 });

	const encoder = new TextEncoder();
	const frame = (channel: Channel) => encoder.encode(`data: ${JSON.stringify(channel.current)}\n\n`);
	/** Tell the notifier where a conversation stands, and whether a client has it open. */
	const attend = (channel: Channel) => (channel.own ? options.notifier?.update(channel.id, channel.current, channel.streams.size > 0) : undefined);
	const send = (channel: Channel, bytes: Uint8Array) => {
		let left = false;
		for (const stream of [...channel.streams]) {
			try {
				stream.enqueue(bytes);
			} catch {
				channel.streams.delete(stream); // the client went away
				left = true;
			}
		}
		if (left) attend(channel);
	};
	// Whether a model can be used is asked at most once a second: a snapshot is sent per streamed token.
	const checked = new Map<string, { at: number; note: string | undefined }>();
	const setupNote = async (model: string | undefined): Promise<string | undefined> => {
		const key = model ?? "";
		const last = checked.get(key);
		if (last && Date.now() - last.at < 1_000) return last.note;
		const note = (await setupOf(models, model).catch(() => undefined))?.note;
		checked.set(key, { at: Date.now(), note });
		return note;
	};
	// The release gate is another process and writes `release.json`; what it says is read here, never asked of it.
	let releaseNow = releaseView(dir);
	const ready = async (state: StateView): Promise<StateView> => {
		const { setup: _old, release: _was, ...rest } = state;
		const note = await setupNote(state.model);
		return { ...rest, ...(releaseNow ? { release: releaseNow } : {}), ...(note ? { setup: note } : {}) };
	};
	// A conversation is watched from the first call that names it; one watch feeds all its streams.
	const channels = new Map<string, Promise<Channel>>();
	const open = async (id: string): Promise<Channel> => {
		const conversation = await core.conversation(id);
		if (!conversation) throw new Refusal(404, "That conversation does not exist.");
		const watch = await conversation.watch(context);
		const own = await core.persons(id);
		const pendingOf = async (ref: unknown) => (await core.harness.snapshot(Approvals, ref as never, context))?.pending ?? [];
		/** This conversation's workers, as the page is shown them. */
		const mine = async (): Promise<Worker[]> => (own ? (await core.workers.list()).filter((worker) => worker.from === id) : []);
		const liveOnes = (workers: Worker[]) => workers.filter((worker) => worker.endedAt === undefined);
		// A worker's request for a yes is shown here, in the thread that handed it the job, under its name.
		const approvals = async (): Promise<StateView["approvals"]> => {
			if (!own) return []; // a worker's thread is read only: its cards are answered where the job came from
			const asked = [{ pending: await pendingOf(conversation.id), worker: undefined as string | undefined }];
			for (const worker of liveOnes(await mine())) if (worker.conversation !== undefined) asked.push({ pending: await pendingOf(worker.conversation), worker: `${worker.id}: ${worker.title}` });
			return asked.flatMap(({ pending, worker }) => pending.map(({ id: ask, tool, command, what, details }) => ({ id: ask, tool, command, what, ...(details ? { details } : {}), ...(worker ? { worker } : {}) })));
		};
		/** The step a worker is on: its running tool and what that acts on, from its own thread. */
		const stepOf = async (worker: Worker): Promise<string | undefined> => {
			if (worker.status !== "working" || worker.conversation === undefined) return undefined;
			const live = await core.harness.snapshot(LiveDoc, worker.conversation as never, context);
			const tool = (live?.tools ?? []).find((candidate) => candidate.status !== "done");
			if (!tool) return undefined;
			const thread = await core.harness.conversation(worker.conversation as never, context);
			const calls = ((await thread?.entries({ order: "descending" }, 4, undefined, context))?.items ?? []).flatMap((entry) => { const view = entryView(entry); return view?.role === "assistant" ? view.calls : []; });
			const args = calls.find((call) => call.id === tool.callId)?.args ?? {};
			const target = args.path ?? args.command ?? args.pattern ?? args.url ?? args.query ?? "";
			return `${tool.name}${typeof target === "string" && target !== "" ? ` ${target.split("\n")[0]!.slice(0, 120)}` : ""}`;
		};
		const workers = async (): Promise<Pick<StateView, "workers" | "workerThread">> => {
			if (!own) {
				const worker = (await core.workers.list()).find((candidate) => String(candidate.conversation) === id);
				return worker ? { workerThread: { id: worker.id, title: worker.title, from: worker.from === core.rootId ? "" : worker.from } } : {};
			}
			const shown = (await mine()).filter((worker) => worker.endedAt === undefined || worker.endedAt > Date.now() - 24 * 3600_000);
			if (shown.length === 0) return {};
			const views: WorkerView[] = [];
			for (const worker of shown) {
				const step = await stepOf(worker).catch(() => undefined);
				views.push({ id: worker.id, title: worker.title, place: worker.place, status: worker.status, createdAt: worker.createdAt, ...(worker.startedAt ? { startedAt: worker.startedAt } : {}), ...(worker.endedAt ? { endedAt: worker.endedAt } : {}), ...(worker.conversation !== undefined ? { conversation: String(worker.conversation) } : {}), ...(step ? { step } : {}) });
			}
			return { workers: views };
		};
		const whole = async (view: StateView): Promise<StateView> => {
			const { workers: _old, workerThread: _was, ...rest } = view;
			return ready({ ...rest, ...(await workers()) });
		};
		const channel: Channel = {
			id,
			conversation,
			own,
			current: await whole(stateView(watch.value, await approvals())),
			streams: new Set(),
			refresh: async () => {
				const next = await whole({ ...channel.current, approvals: await approvals() });
				if (JSON.stringify(next) === JSON.stringify(channel.current)) return;
				channel.current = next;
				send(channel, frame(channel));
				attend(channel);
			},
			stop: () => watch.stop(),
		};
		watch.start(async (call) => {
			if (call.kind !== "value") return;
			channel.current = await whole(stateView(call.value, await approvals()));
			send(channel, frame(channel));
			attend(channel);
		});
		attend(channel);
		return channel;
	};
	const channelFor = (id: string): Promise<Channel> => {
		let found = channels.get(id);
		if (!found) {
			found = open(id);
			channels.set(id, found);
			found.catch(() => channels.delete(id));
		}
		return found;
	};
	/** The conversation a request names, to read: one of the person's, or a worker's thread. */
	const viewOf = (url: URL): Promise<Channel> => channelFor(url.searchParams.get("c") || core.rootId);
	/** The conversation a request names, to change: only one of the person's own. */
	const channelOf = async (url: URL): Promise<Channel> => {
		const channel = await viewOf(url);
		if (!channel.own) throw new Refusal(403, "A worker's thread is read only.");
		return channel;
	};
	const opened = async (): Promise<Channel[]> => (await Promise.allSettled(channels.values())).flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
	/** Look at the release again; when it moved, every open conversation is told. */
	const syncRelease = async (): Promise<void> => {
		const next = releaseView(dir);
		if (JSON.stringify(next) === JSON.stringify(releaseNow)) return;
		releaseNow = next;
		for (const channel of await opened()) {
			const { release: _was, ...rest } = channel.current;
			channel.current = { ...rest, ...(next ? { release: next } : {}) };
			send(channel, frame(channel));
		}
	};
	// Only while somebody is looking: an idle rho does not wake for this.
	const releaseWatch = setInterval(async () => {
		if ((await opened()).some((channel) => channel.streams.size > 0)) await syncRelease();
	}, options.releasePollMs ?? 2_000);
	releaseWatch.unref?.();
	// A change to a worker (started, asks, ended) is shown at once; the step it is on is looked at
	// again every few seconds, and only while a page is open on a conversation that has a live worker.
	const refreshOpen = async (onlyWatched: boolean) => {
		for (const channel of await opened()) if (channel.own && (!onlyWatched || (channel.streams.size > 0 && (channel.current.workers ?? []).some((worker) => worker.endedAt === undefined)))) await channel.refresh().catch(() => undefined);
	};
	const unwatchWorkers = core.workers.onChange(() => void refreshOpen(false));
	const workerWatch = setInterval(() => void refreshOpen(true), options.workerPollMs ?? 3_000);
	workerWatch.unref?.();
	const keepalive = setInterval(async () => {
		for (const channel of await opened()) send(channel, encoder.encode(": keepalive\n\n")); // a silent stream is a dead one
	}, 15_000);
	keepalive.unref?.();

	const routes: Record<string, (request: Request, url: URL) => Promise<unknown>> = {
		"POST /api/submit": async (request, url) => {
			const { conversation, id } = await channelOf(url);
			const { text = "", requestId, whenBusy, from, images } = await bodyOf(request, { bytes: MAX_UPLOAD, chars: MAX_UPLOAD, words: "Those photos are too large to send together. Send fewer at a time." });
			// A photo may go without words; nothing else may.
			if (typeof text !== "string" || (text.trim() === "" && (images === undefined || from !== undefined))) throw new Refusal(400, "Write a message first.");
			if (text.length > MAX_BODY) throw new Refusal(413, "The message is too long.");
			if (typeof requestId !== "string" || requestId.length < 8 || requestId.length > 100) throw new Refusal(400, "requestId is required: 8 to 100 characters, the same on a resend.");
			// `from` marks a message the person did not write (the release gate's report).
			if (from !== undefined) {
				if (typeof from !== "string" || !/^[a-z-]{1,20}$/.test(from)) throw new Refusal(400, "from is a short lower-case name.");
				return { ok: true, submissionId: await core.notice(conversation, text, requestId, from) };
			}
			let content: string | ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[] = text;
			if (images !== undefined) {
				// Said now, in words, rather than by a provider's error after the photo is in the thread.
				const ref = (await conversation.agent(context)).model;
				const model = ref && (await models.getAvailable()).find((known) => known.provider === ref.provider && known.id === ref.modelId);
				if (model && !model.input.includes("image")) throw new Refusal(400, "This conversation's model does not take photos. Choose another model in the menu.");
				try {
					// Pictures first, then the words about them.
					content = [...(await takePhotos(images, options.images)), ...(text.trim() === "" ? [] : [{ type: "text" as const, text }])];
				} catch (error) {
					if (error instanceof PhotoRefused) throw new Refusal(400, error.message);
					throw error;
				}
			}
			const submission = await conversation.submit({ type: "input", content, requestId, whenBusy: whenBusy === "steer" ? "steer" : "followUp" }, context);
			await core.title(id, text.trim() === "" ? "Photo" : text);
			return { ok: true, submissionId: String(submission.id) };
		},
		// Stop also stops a check-in that is running unseen beside the conversations.
		"POST /api/stop": async (_request, url) => (await Promise.all([(await channelOf(url)).conversation.abort(context), core.reminders?.stop()]), { ok: true }),
		"POST /api/new": async (_request, url) => (await (await channelOf(url)).conversation.reset(undefined, context), { ok: true }),
		"POST /api/unqueue": async (request) => {
			const { id } = await bodyOf(request);
			if (typeof id !== "string") throw new Refusal(400, "id is required.");
			const submission = await core.harness.submission(id as never, context);
			return { ok: true, result: submission ? await submission.abort(context) : "settled" };
		},
		"POST /api/model": async (request, url) => {
			const { conversation } = await channelOf(url);
			const { model, thinking } = await bodyOf(request);
			if (model !== undefined) {
				if (typeof model !== "string") throw new Refusal(400, "model is written provider/model.");
				let ref: { provider: string; modelId: string };
				try {
					ref = parseModel(model);
				} catch (error) {
					throw new Refusal(400, (error as Error).message);
				}
				if (!(await models.getAvailable()).some((known) => known.provider === ref.provider && known.id === ref.modelId)) throw new Refusal(400, "That model is not available.");
				await conversation.configure({ model: ref }, context);
			}
			if (thinking !== undefined) {
				if (typeof thinking !== "string" || !THINKING.has(thinking)) throw new Refusal(400, `thinking is one of: ${[...THINKING].join(", ")}.`);
				await conversation.configure({ thinkingLevel: thinking as never }, context);
			}
			return { ok: true };
		},
		"POST /api/approve": async (request, url) => {
			const channel = await channelOf(url);
			const { id, allow } = await bodyOf(request);
			if (typeof id !== "string" || typeof allow !== "boolean") throw new Refusal(400, "id and allow are required.");
			let answered = await answerApproval(channel.conversation, id, allow, context);
			// Not the agent's own: a worker's, shown in this thread. The answer is left for the worker, which is told it and goes on.
			let workers = false;
			for (const worker of answered ? [] : (await core.workers.list()).filter((candidate) => candidate.from === channel.id && candidate.endedAt === undefined && candidate.conversation !== undefined)) {
				const thread = await core.harness.conversation(worker.conversation as never, context);
				answered = thread && (await answerApproval(thread, id, allow, context));
				if (answered) {
					workers = true;
					break;
				}
			}
			if (!answered) throw new Refusal(409, "That request is no longer waiting."); // an approval answers once
			recordAnswer(dir, { at: Date.now(), event: allow ? "allow" : "deny", id: answered.id, conversation: channel.id, tool: answered.tool, what: answered.what, command: answered.command, waitedMs: Date.now() - answered.at });
			await channel.refresh();
			if (workers) return { ok: true };
			// The person's answer reaches the agent as their message, at its next step.
			const shell = answered.tool === "bash"; // another tool's request (a settings change) is not something to run
			const text = allow ? `Yes. ${shell ? "Run it" : "Do it"}: \`${answered.command}\`` : `No. Do not ${shell ? "run" : "do it"}: \`${answered.command}\``;
			await channel.conversation.submit({ type: "input", content: text, requestId: `approval:${id}`, whenBusy: "steer" }, context);
			return { ok: true };
		},
		"POST /api/cwd": async (request, url) => {
			const path = directory((await bodyOf(request)).path);
			await (await channelOf(url)).conversation.configure({ cwd: path }, context);
			return { ok: true };
		},
		"GET /api/conversations": async () => ({
			items: await Promise.all(
				(await core.conversations()).map(async (info) => {
					const conversation = (await core.conversation(info.id))!;
					const agent = await conversation.agent(context);
					const live = await core.harness.snapshot(LiveDoc, conversation.id, context);
					return { id: info.id, title: info.title, root: info.id === core.rootId, cwd: agent.cwd, model: agent.model ? `${agent.model.provider}/${agent.model.modelId}` : undefined, running: live?.run !== undefined };
				}),
			),
		}),
		"POST /api/conversations": async (request) => {
			const { cwd } = await bodyOf(request);
			const made = await core.create(cwd === undefined ? {} : { cwd: directory(cwd) });
			if (options.notifier) void channelFor(made.id).catch(() => undefined); // watched from its first moment
			return { id: made.id };
		},
		// What the first conversation's model needs before it can answer, for `rho status`.
		"GET /api/setup": async () => {
			const agent = await core.root.agent(context);
			const model = agent.model ? `${agent.model.provider}/${agent.model.modelId}` : undefined;
			checked.clear();
			return { ...(await setupOf(models, model)), available: (await models.getAvailable()).length };
		},
		"GET /api/workers": async () => ({ items: (await core.workers.list()).map(({ id, title, place, status, from, createdAt, startedAt, endedAt }) => ({ id, title, place, status, from, createdAt, startedAt, endedAt })) }),
		"POST /api/workers/stop": async (request) => {
			const { id } = await bodyOf(request);
			if (typeof id !== "string") throw new Refusal(400, "id is required.");
			if (!(await core.workers.stop(id))) throw new Refusal(409, "That worker is not running.");
			return { ok: true };
		},
		"GET /api/reminders": async () => ({ items: (await core.reminders?.list()) ?? [] }),
		"POST /api/reminders/remove": async (request) => {
			const { id } = await bodyOf(request);
			if (typeof id !== "string" || !(await core.reminders?.remove(id))) throw new Refusal(404, "No such reminder.");
			return { ok: true };
		},
		"GET /api/models": async () => ({ items: (await models.getAvailable()).map((model) => ({ id: `${model.provider}/${model.id}`, name: model.name ?? model.id, provider: model.provider })) }),
		"GET /api/earlier": async (_request, url) => {
			const before = Number(url.searchParams.get("before"));
			if (!Number.isSafeInteger(before) || before < 1) throw new Refusal(400, "before is required: the id of the oldest entry you have.");
			const page = await (await viewOf(url)).conversation.entries({ maxEntryId: (before - 1) as never, order: "descending" }, 40, undefined, context);
			return { entries: page.items.flatMap((entry) => entryView(entry) ?? []).reverse(), more: page.items.length === 40 };
		},
		// One photo of one of the person's own messages. The stream names how many there are; the
		// picture itself is sent only when asked for, to a client that holds the token.
		"GET /api/image": async (_request, url) => {
			const entry = Number(url.searchParams.get("entry"));
			const n = Number(url.searchParams.get("n") ?? 0);
			if (!Number.isSafeInteger(entry) || entry < 1 || !Number.isSafeInteger(n) || n < 0) throw new Refusal(400, "entry and n are required: the message's id and the photo's place in it.");
			const page = await (await channelOf(url)).conversation.entries({ minEntryId: entry as never, maxEntryId: entry as never, order: "ascending" }, 1, undefined, context);
			const found = page.items[0];
			const message = found?.kind === "pi.user" ? found.model?.[0] : undefined;
			const photo = message?.role === "user" && Array.isArray(message.content) ? message.content.filter((part) => part.type === "image")[n] : undefined;
			if (!photo) throw new Refusal(404, "No such photo.");
			return { mimeType: photo.mimeType, data: photo.data };
		},
		"GET /api/health": async () => ({ ok: true, pid: process.pid, startedAt }),
	};

	const startedAt = Date.now();
	const server = Bun.serve({
		maxRequestBodySize: MAX_UPLOAD,
		hostname: "127.0.0.1",
		port: options.port,
		idleTimeout: 0,
		async fetch(request) {
			const url = new URL(request.url);
			const origins = new Set([`http://127.0.0.1:${server.port}`, `http://localhost:${server.port}`]);
			try {
				// A page from any other origin must not drive the agent, with or without a preflight.
				const origin = request.headers.get("origin");
				if (origin !== null && !origins.has(origin)) return json(403, { error: "This origin is not allowed." });
				// Only these host names are served, so a DNS name pointed at 127.0.0.1 gets nothing.
				if (!origins.has(`http://${request.headers.get("host")}`)) return json(403, { error: "This host is not allowed." });
				if (!url.pathname.startsWith("/api/")) return (request.method === "GET" ? await pageFile(url.pathname) : undefined) ?? json(404, { error: "Not found." });

				if (request.method === "POST" && url.pathname === "/api/pair") {
					const { code } = await bodyOf(request);
					if (typeof code !== "string" || !same(code, pairCode)) return json(401, { error: "That pairing link was already used. Run: rho open" });
					pairCode = randomBytes(16).toString("base64url");
					savePairCode();
					return json(200, { token });
				}
				const given = (request.headers.get("authorization") ?? "").replace(/^Bearer /, "");
				if (!same(given, token)) return json(401, { error: "Not paired. Run: rho open" });

				if (request.method === "GET" && url.pathname === "/api/events") {
					const channel = await viewOf(url);
					await syncRelease(); // a client that connects is shown where a release is now
					let mine: Stream;
					const body = new ReadableStream<Uint8Array>({
						start(controller) {
							mine = controller;
							controller.enqueue(frame(channel));
							channel.streams.add(controller);
							attend(channel); // someone is looking: what is on the page now needs no notification
						},
						cancel() {
							channel.streams.delete(mine);
							attend(channel); // they left: a request still waiting is notified now
						},
					});
					return new Response(body, { headers: { "content-type": "text/event-stream", "cache-control": "no-store", "x-accel-buffering": "no" } });
				}
				const route = routes[`${request.method} ${url.pathname}`];
				if (!route) return json(404, { error: "Not found." });
				return json(200, await route(request, url));
			} catch (error) {
				if (error instanceof Refusal) return json(error.status, { error: error.message });
				const name = (error as Error | undefined)?.name;
				if (name === "ConversationBusy") return json(409, { error: "Rho is busy." });
				log(`http: ${(error as Error)?.stack ?? String(error)}`);
				return json(500, { error: String((error as Error)?.message ?? error).slice(0, 300) });
			}
		},
	});
	savePairCode();
	// To notify with the page closed, every one of the person's conversations is watched from the start.
	if (options.notifier) for (const info of await core.conversations()) await channelFor(info.id).catch((error: Error) => log(`notifications: ${info.id} is not watched: ${error.message}`));
	writeFileSync(join(dir, "daemon.json"), JSON.stringify({ pid: process.pid, port: server.port, startedAt, commit: options.commit, root: resolve(import.meta.dir, "..") }), { mode: 0o600 });
	return {
		port: server.port ?? options.port,
		pairCode: () => pairCode,
		stop: async () => {
			clearInterval(keepalive);
			clearInterval(releaseWatch);
			clearInterval(workerWatch);
			unwatchWorkers();
			for (const channel of await opened()) {
				await channel.stop();
				for (const stream of channel.streams) {
					try {
						stream.close();
					} catch {
						// already closed
					}
				}
			}
			await server.stop(true);
		},
	};
}
