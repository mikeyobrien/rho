// The daemon's door: HTTP on loopback only. Every API call carries the bearer token; the one
// exception is trading a one-time pairing code for it. State reaches a client as server-sent
// events, each a whole snapshot (view.ts), so a reconnect needs no replay.
import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { extname, isAbsolute, join, resolve, sep } from "node:path";
import type { Models } from "@earendil-works/pi-ai";
import type { Core } from "./core.ts";
import { context, parseModel } from "./core.ts";
import { answerApproval, Approvals } from "./tools/guard.ts";
import { entryView, stateView, type StateView } from "./view.ts";

export interface ServerOptions {
	core: Core;
	models: Models;
	dir: string;
	port: number;
	log?: (line: string) => void;
}
export interface Server {
	port: number;
	/** The one-time code a new browser trades for the token. Replaced each time it is used. */
	pairCode(): string;
	stop(): Promise<void>;
}

const MAX_BODY = 256 * 1024;
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

async function bodyOf(request: Request): Promise<Record<string, unknown>> {
	const text = await request.text();
	if (text.length > MAX_BODY) throw new Refusal(413, "The message is too long.");
	try {
		const value = JSON.parse(text || "{}") as unknown;
		if (typeof value === "object" && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
	} catch {
		// refused below
	}
	throw new Refusal(400, "The request is not a JSON object.");
}

export async function serve(options: ServerOptions): Promise<Server> {
	const { core, models, dir } = options;
	const log = options.log ?? (() => {});
	const root = core.root;

	const tokenPath = join(dir, "token");
	if (!existsSync(tokenPath)) writeFileSync(tokenPath, randomBytes(32).toString("base64url"), { mode: 0o600 });
	const token = readFileSync(tokenPath, "utf8").trim();
	let pairCode = randomBytes(16).toString("base64url");
	const savePairCode = () => writeFileSync(join(dir, "pair-code"), pairCode, { mode: 0o600 });

	// One watch on the conversation feeds every open stream.
	const encoder = new TextEncoder();
	const streams = new Set<ReadableStreamDefaultController<Uint8Array>>();
	const watch = await root.watch(context);
	const approvals = async (): Promise<StateView["approvals"]> => ((await core.harness.snapshot(Approvals, root.id, context))?.pending ?? []).map(({ id, tool, command, what }) => ({ id, tool, command, what }));
	let current: StateView = stateView(watch.value, await approvals());
	const frame = () => encoder.encode(`data: ${JSON.stringify(current)}\n\n`);
	const send = (bytes: Uint8Array) => {
		for (const stream of [...streams]) {
			try {
				stream.enqueue(bytes);
			} catch {
				streams.delete(stream); // the client went away
			}
		}
	};
	watch.start(async (call) => {
		if (call.kind !== "value") return;
		current = stateView(call.value, await approvals());
		send(frame());
	});
	const keepalive = setInterval(() => send(encoder.encode(": keepalive\n\n")), 15_000); // a silent stream is a dead one
	keepalive.unref?.();

	const routes: Record<string, (request: Request, url: URL) => Promise<unknown>> = {
		"POST /api/submit": async (request) => {
			const { text, requestId, whenBusy } = await bodyOf(request);
			if (typeof text !== "string" || text.trim() === "") throw new Refusal(400, "Write a message first.");
			if (typeof requestId !== "string" || requestId.length < 8 || requestId.length > 100) throw new Refusal(400, "requestId is required: 8 to 100 characters, the same on a resend.");
			const submission = await root.submit({ type: "input", content: text, requestId, whenBusy: whenBusy === "steer" ? "steer" : "followUp" }, context);
			return { ok: true, submissionId: String(submission.id) };
		},
		"POST /api/stop": async () => (await root.abort(context), { ok: true }),
		"POST /api/new": async () => (await root.reset(undefined, context), { ok: true }),
		"POST /api/unqueue": async (request) => {
			const { id } = await bodyOf(request);
			if (typeof id !== "string") throw new Refusal(400, "id is required.");
			const submission = await core.harness.submission(id as never, context);
			return { ok: true, result: submission ? await submission.abort(context) : "settled" };
		},
		"POST /api/model": async (request) => {
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
				await root.configure({ model: ref }, context);
			}
			if (thinking !== undefined) {
				if (typeof thinking !== "string" || !THINKING.has(thinking)) throw new Refusal(400, `thinking is one of: ${[...THINKING].join(", ")}.`);
				await root.configure({ thinkingLevel: thinking as never }, context);
			}
			return { ok: true };
		},
		"POST /api/approve": async (request) => {
			const { id, allow } = await bodyOf(request);
			if (typeof id !== "string" || typeof allow !== "boolean") throw new Refusal(400, "id and allow are required.");
			const answered = await answerApproval(root, id, allow, context);
			if (!answered) throw new Refusal(409, "That request is no longer waiting."); // an approval answers once
			current = { ...current, approvals: await approvals() };
			send(frame());
			// The person's answer reaches the agent as their message, at its next step.
			const text = allow ? `Yes. Run it: \`${answered.command}\`` : `No. Do not run: \`${answered.command}\``;
			await root.submit({ type: "input", content: text, requestId: `approval:${id}`, whenBusy: "steer" }, context);
			return { ok: true };
		},
		"POST /api/cwd": async (request) => {
			const { path } = await bodyOf(request);
			if (typeof path !== "string" || !isAbsolute(path)) throw new Refusal(400, "path is an absolute directory.");
			if (!existsSync(path) || !statSync(path).isDirectory()) throw new Refusal(400, "That directory does not exist.");
			await root.configure({ cwd: resolve(path) }, context);
			return { ok: true };
		},
		"GET /api/models": async () => ({ items: (await models.getAvailable()).map((model) => ({ id: `${model.provider}/${model.id}`, name: model.name ?? model.id, provider: model.provider })) }),
		"GET /api/earlier": async (_request, url) => {
			const before = Number(url.searchParams.get("before"));
			if (!Number.isSafeInteger(before) || before < 1) throw new Refusal(400, "before is required: the id of the oldest entry you have.");
			const page = await root.entries({ maxEntryId: (before - 1) as never, order: "descending" }, 40, undefined, context);
			return { entries: page.items.flatMap((entry) => entryView(entry) ?? []).reverse(), more: page.items.length === 40 };
		},
		"GET /api/health": async () => ({ ok: true, pid: process.pid, startedAt, running: current.running, model: current.model }),
	};

	const startedAt = Date.now();
	const server = Bun.serve({
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
					let mine: ReadableStreamDefaultController<Uint8Array>;
					const body = new ReadableStream<Uint8Array>({
						start(controller) {
							mine = controller;
							controller.enqueue(frame());
							streams.add(controller);
						},
						cancel() {
							streams.delete(mine);
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
	writeFileSync(join(dir, "daemon.json"), JSON.stringify({ pid: process.pid, port: server.port, startedAt }), { mode: 0o600 });
	return {
		port: server.port ?? options.port,
		pairCode: () => pairCode,
		stop: async () => {
			clearInterval(keepalive);
			await watch.stop();
			for (const stream of streams) {
				try {
					stream.close();
				} catch {
					// already closed
				}
			}
			await server.stop(true);
		},
	};
}
