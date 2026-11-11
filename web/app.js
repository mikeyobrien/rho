// The rho page. The daemon's event stream is the state: this page keeps no second copy beyond
// older entries it has paged in, the draft, and messages it could not send yet.
import { renderMarkdown } from "./markdown.js";

const IDLE_MS = 30_000; // the daemon sends a keepalive every 15 s; this long with nothing is a dead path
const THINKING = ["low", "medium", "high", "xhigh", "max"];
// Photos. The daemon checks all of this again; here it only saves a refused upload.
const MAX_PHOTOS = 4;
const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
const MAX_UPLOAD_CHARS = 26 * 1024 * 1024; // base64 of all photos of one message together
const PHOTO_TYPE = /^image\/(jpeg|png|gif|webp)$/;
const count = (n) => (n === 1 ? "1 photo" : `${n} photos`);
function toBase64(bytes) {
	const parts = [];
	for (let i = 0; i < bytes.length; i += 8192) parts.push(String.fromCharCode.apply(null, bytes.subarray(i, i + 8192))); // in pieces: megabytes of arguments overflow the stack
	return btoa(parts.join(""));
}

/**
 * Start the page. `env` is what it touches of the browser: `document`, `storage` (localStorage),
 * `location`, `history`, `fetch`, and optionally `touch`, `visible()` and `shrink(file)`, which
 * makes a large photo smaller before it is sent. Returns `stop()`.
 */
export function start(env) {
	const { document, storage, location, history } = env;
	const $ = (id) => document.getElementById(id);
	const make = (tag, props) => Object.assign(document.createElement(tag), props);
	const el = {
		status: $("status"), thread: $("thread"), entries: $("entries"), live: $("live"), empty: $("empty"), earlier: $("earlier"), latest: $("latest"),
		notice: $("notice"), noticeText: $("notice-text"), queue: $("queue"), composer: $("composer"), input: $("input"), send: $("send"),
		menuButton: $("menu-button"), menu: $("menu"), model: $("model"), thinking: $("thinking"), newChat: $("new-chat"),
		conversations: $("conversations"), newConversation: $("new-conversation"),
		attach: $("attach"), photoInput: $("photo-input"), photos: $("photos"), release: $("release"), releaseText: $("release-text"),
		showWorkers: $("show-workers"), workers: $("workers"), workerThread: $("worker-thread"), footer: $("composer"),
	};
	const store = {
		get(key, fallback) {
			try {
				const value = storage.getItem(key);
				return value === null ? fallback : JSON.parse(value);
			} catch {
				return fallback;
			}
		},
		set(key, value) {
			try {
				storage.setItem(key, JSON.stringify(value));
			} catch {
				// Storage full or blocked: the page still works for this visit.
			}
		},
	};

	let token = store.get("token", "");
	let conversation = store.get("conversation", ""); // the open conversation; "" is the first one
	let state; // the newest snapshot from the daemon
	let connection = "connecting"; // connecting | live | offline | unpaired
	let outbox = store.get("outbox", []); // [{ requestId, text, images? }] not yet accepted by the daemon
	// Photos are too large for the browser's storage, so a kept message is stored without them and
	// says how many it had. One found that way after a reload is not sent short: its words go back in the box.
	const keepOutbox = () => store.set("outbox", outbox.map(({ images, ...item }) => (images ? { ...item, photos: images.length } : item)));
	const lostPhotos = outbox.filter((item) => item.photos);
	if (lostPhotos.length > 0) {
		outbox = outbox.filter((item) => !item.photos);
		keepOutbox();
		if (store.get("draft", "") === "") store.set("draft", lostPhotos.map((item) => item.text).filter(Boolean).join("\n\n"));
	}
	let chosen = []; // [{ type, data }] photos picked for the next message; in memory only
	let reading = 0; // photos still being read from the device
	const known = new Map(); // entry id -> entry, including older pages
	let moreEarlier = false;
	let sending = false;
	let stopped = false;
	let streamRun = 0;
	let streamAbort;

	// --- talking to the daemon -------------------------------------------------------------
	const at = (path, id) => (id ? `${path}${path.includes("?") ? "&" : "?"}c=${encodeURIComponent(id)}` : path);
	async function api(path, body, id = conversation) {
		const response = await env.fetch(at(`/api/${path}`, id), {
			method: body === undefined ? "GET" : "POST",
			headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		const data = await response.json().catch(() => ({}));
		if (!response.ok) throw Object.assign(new Error(data.error ?? `Rho answered ${response.status}.`), { status: response.status });
		return data;
	}

	async function pair() {
		const code = new URLSearchParams(location.hash.slice(1)).get("pair");
		if (!code) return;
		history.replaceState(null, "", location.pathname + location.search); // the code is one use: take it out of the address
		try {
			const response = await env.fetch("/api/pair", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code }) });
			const data = await response.json();
			if (!response.ok || !data.token) return;
			// A message held for another rho is never sent to this one: its words go back in the box.
			if (token !== "" && token !== data.token && outbox.length > 0) {
				store.set("draft", outbox.map((item) => item.text).join("\n\n"));
				outbox = [];
				keepOutbox();
			}
			if (token !== data.token) {
				conversation = ""; // another rho has other conversations
				store.set("conversation", conversation);
			}
			token = data.token;
			store.set("token", token);
		} catch {
			// The stream below reports what is wrong.
		}
	}

	async function stream() {
		const run = ++streamRun;
		streamAbort?.abort();
		let wait = 500;
		while (run === streamRun && !stopped) {
			const abort = new AbortController();
			streamAbort = abort;
			let timer;
			const arm = () => {
				clearTimeout(timer);
				timer = setTimeout(() => abort.abort(), IDLE_MS);
			};
			try {
				arm();
				const response = await env.fetch(at("/api/events", conversation), { headers: { authorization: `Bearer ${token}` }, signal: abort.signal });
				if (response.status === 401) return setConnection("unpaired");
				if (response.status === 404 && conversation !== "") {
					// The conversation this browser had open is gone: open the first one.
					conversation = "";
					store.set("conversation", conversation);
					continue;
				}
				if (!response.ok || !response.body) throw new Error(`status ${response.status}`);
				const reader = response.body.getReader();
				const decoder = new TextDecoder();
				let buffer = "";
				wait = 500;
				for (;;) {
					const { value, done } = await reader.read();
					if (done) break;
					arm();
					buffer += decoder.decode(value, { stream: true });
					let end;
					while ((end = buffer.indexOf("\n\n")) !== -1) {
						const frame = buffer.slice(0, end);
						buffer = buffer.slice(end + 2);
						if (run !== streamRun || stopped) return;
						if (frame.startsWith("data: ")) {
							setConnection("live");
							apply(JSON.parse(frame.slice(6)));
						}
					}
				}
			} catch {
				// Fall through to the retry.
			} finally {
				clearTimeout(timer);
			}
			if (run !== streamRun || stopped) return;
			setConnection("offline");
			await new Promise((resolve) => setTimeout(resolve, wait));
			wait = Math.min(wait * 2, 5_000);
		}
	}

	// --- state -----------------------------------------------------------------------------------
	function setConnection(next) {
		if (connection === next) return;
		connection = next;
		if (next === "live") void flushOutbox();
		render();
	}

	function apply(next) {
		// Another conversation, or a storage that started over: what was paged in no longer belongs.
		if (state && state.conversation !== next.conversation) {
			known.clear();
			rendered.clear();
			folded.clear();
			drawn = undefined;
		}
		state = next;
		for (const entry of next.entries) known.set(entry.id, entry);
		if (known.size === next.entries.length) moreEarlier = next.more;
		render();
	}

	async function flushOutbox() {
		if (sending) return;
		sending = true;
		try {
			while (outbox.length > 0 && connection === "live" && !stopped) {
				const item = outbox[0];
				try {
					// A kept message goes to the conversation it was written in, whichever is open now.
					await api("submit", { text: item.text, requestId: item.requestId, whenBusy: item.mode ?? "steer", ...(item.images ? { images: item.images.map((photo) => ({ data: photo.data })) } : {}) }, item.c ?? "");
				} catch (error) {
					if (error.status === undefined) return; // not reached: it stays "Not sent yet" and goes again later
					// The daemon refused it: give the words and the photos back instead of losing them.
					if (el.input.value.trim() === "") setDraft(item.text);
					if (item.images && chosen.length === 0) {
						chosen = item.images;
						renderChosen();
					}
					flash(error.message);
				}
				outbox = outbox.slice(1);
				keepOutbox();
				render();
			}
		} finally {
			sending = false;
		}
	}

	// A message sent while rho works joins the work in hand at its next step ("steer"); the
	// person can make it wait for the answer instead ("followUp"). Idle, both start a run.
	function submit(text, mode = "steer", images = []) {
		outbox = [...outbox, { requestId: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`, text, mode, c: conversation, ...(images.length > 0 ? { images } : {}) }];
		keepOutbox();
		stick = true;
		render();
		void flushOutbox();
	}

	// --- drawing ---------------------------------------------------------------------------------
	let stick = true; // follow the newest message only while the reader is already at the bottom
	let drawn = "";
	const rendered = new Map(); // entry id -> node, so a settled reply is laid out once
	const firstLine = (text) => text.trim().split("\n")[0].slice(0, 80);
	const note = (text, className = "note") => make("p", { className, textContent: text });

	/** What a call acts on, in short: its path, command, pattern, address or query. */
	function targetOf(call) {
		const args = call?.args ?? {};
		const value = args.path ?? args.command ?? args.pattern ?? args.url ?? args.query ?? Object.values(args).find((item) => typeof item === "string") ?? "";
		return firstLine(typeof value === "string" ? value : JSON.stringify(value));
	}
	/**
	 * A tool call as two lines: what it is for, then what it acted on and how it went. The
	 * output, and for an edit the diff, are inside and shown when the card is opened.
	 */
	function toolCard(name, call, result, body, error, diff) {
		const card = make("details", { className: error ? "tool error" : "tool" });
		const head = make("summary", {});
		const why = make("div", { className: "tool-line" });
		why.append(make("span", { className: "tool-name", textContent: name }), make("span", { className: "tool-why", textContent: call?.reasoning ?? "" }));
		const what = make("div", { className: "tool-line" });
		what.append(make("span", { className: "tool-target", textContent: targetOf(call) }), make("span", { className: "tool-result", textContent: result }));
		head.append(why, what);
		card.append(head);
		if (diff !== undefined) {
			const lines = make("pre", { className: "diff" });
			for (const line of diff.split("\n")) lines.append(make("span", { className: line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : "same", textContent: `${line}\n` }));
			card.append(lines);
		}
		card.append(make("pre", { className: "output", textContent: body }));
		return card;
	}

	/**
	 * How a piece of side work ended, as a card: whose it was and how it ended, then one line.
	 * The rest opens on a tap. Built from stored fields with textContent only; nothing in it runs.
	 */
	const VERDICT_WORDS = { done: "done", partial: "partial", failed: "failed" };
	function reportCard(card) {
		const node = make("details", { className: `report ${card.verdict}` });
		const head = make("summary", {});
		const top = make("div", { className: "report-line" });
		top.append(make("span", { className: "report-verdict", textContent: VERDICT_WORDS[card.verdict] ?? card.verdict }), make("span", { className: "report-title", textContent: card.title }));
		// The summary line: the sender's own, or the first words of the body that are not the verdict word itself.
		const lines = (card.body ?? "").split("\n").map((line) => line.trim()).filter((line) => line !== "" && !/^\W*(done|partial|failed)\W*$/i.test(line));
		const brief = card.summary ?? (lines[0] ?? "").replace(/^[#*\s]+|[*\s]+$/g, "");
		const second = make("div", { className: "report-line" });
		second.append(make("span", { className: "report-summary", textContent: brief }), make("span", { className: "report-who", textContent: card.who }));
		head.append(top, second);
		node.append(head);
		if (card.body) {
			const body = make("div", { className: "report-body" });
			renderMarkdown(body, card.body, document);
			node.append(body);
		}
		return node;
	}

	const picture = (n, src) => make("img", { className: "photo", alt: `Photo ${n + 1}`, ...(src ? { src } : {}) });
	const sourceOf = (photo) => `data:${photo.type};base64,${photo.data}`;
	/** A message of the person's: its photos, then its words. */
	function bubble(className, text, pictures) {
		if (pictures.length === 0) return make("div", { className, textContent: text });
		const node = make("div", { className });
		const row = make("div", { className: "photos" });
		row.append(...pictures);
		node.append(row);
		if (text !== "") node.append(make("div", { textContent: text }));
		return node;
	}
	/** A sent photo. The stream says only that it exists; the picture is asked for once, with the token. */
	function sentPhoto(entry, n) {
		const img = picture(n);
		api(`image?entry=${entry.id}&n=${n}`).then(
			(photo) => {
				if (PHOTO_TYPE.test(photo.mimeType)) img.src = `data:${photo.mimeType};base64,${photo.data}`;
			},
			() => {
				img.alt = `Photo ${n + 1} could not be loaded`;
			},
		);
		return img;
	}

	// --- folding finished steps ----------------------------------------------------------------------
	const took = (ms) => (ms < 1000 ? "" : ms < 60_000 ? `${Math.round(ms / 1000)} s` : `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`);
	const KINDS = [["read", "read"], ["grep", "searched"], ["find", "searched"], ["ls", "searched"], ["edit", "edited"], ["write", "wrote"], ["bash", "ran"], ["web_search", "looked up"], ["fetch_content", "looked up"]];
	/**
	 * Whether a finished step may be folded away with its neighbours. A step that failed stays
	 * out, and so does one that acted on a path outside the conversation's directory: those are
	 * what a person skimming must not miss. Edits fold too; the fold's line counts them.
	 */
	function folds(entry, call) {
		if (entry.error) return false;
		const path = call?.args?.path;
		if (typeof path !== "string") return true;
		if (path.startsWith("~") || path.split("/").includes("..")) return false;
		return !path.startsWith("/") || (Boolean(state?.cwd) && (path === state.cwd || path.startsWith(`${state.cwd}/`)));
	}
	/** What a run of folded steps did, in a line: "read 6 · edited 2 (+9 −1) · ran 3". */
	function foldWords(steps) {
		const counts = new Map();
		let [added, removed] = [0, 0];
		for (const step of steps) {
			const word = KINDS.find(([name]) => name === step.name)?.[1] ?? "used tools";
			counts.set(word, (counts.get(word) ?? 0) + 1);
			const change = step.diff === undefined ? null : /^\+(\d+) −(\d+)$/.exec(step.summary);
			if (change) [added, removed] = [added + Number(change[1]), removed + Number(change[2])];
		}
		return [...counts].map(([word, count]) => (word === "edited" && added + removed > 0 ? `${word} ${count} (+${added} −${removed})` : `${word} ${count}`)).join(" · ");
	}
	const folded = new Map(); // first entry id of a fold -> { key, node }: a fold opened by the person stays open
	const FOLD_FROM = 3; // fewer steps than this are clearer as their own cards
	/** One row for a run of finished steps, with the steps' own cards inside. */
	function foldFor(steps, calls) {
		const key = steps.map((step) => step.id).join(",");
		const kept = folded.get(steps[0].id);
		if (kept?.key === key) return kept.node;
		const node = make("details", { className: "fold", open: kept?.node.open ?? false });
		const ms = steps.reduce((sum, step) => sum + (step.ms ?? 0), 0);
		const head = make("summary", {});
		head.append(make("span", { className: "fold-count", textContent: `${steps.length} steps${took(ms) ? ` · ${took(ms)}` : ""}` }), make("span", { className: "fold-words", textContent: foldWords(steps) }));
		const inside = make("div", { className: "fold-steps" });
		inside.append(...steps.map((step) => nodeFor(step, calls)));
		node.append(head, inside);
		folded.set(steps[0].id, { key, node });
		return node;
	}
	/**
	 * The thread's nodes: each entry's own, except that a run of three or more foldable steps in a
	 * row becomes one row. A tool-only turn of the model between two steps (it shows nothing) does
	 * not break a run. The run that is still going is left as cards: its steps are what is happening.
	 */
	function threadNodes(entries, calls) {
		const out = [];
		let run = [];
		const flush = (settled) => {
			if (run.length >= FOLD_FROM && settled) out.push(foldFor(run, calls));
			else out.push(...run.map((step) => nodeFor(step, calls)));
			run = [];
		};
		for (const entry of entries) {
			if (entry.role === "tool" && folds(entry, calls.get(entry.callId))) run.push(entry);
			else if (entry.role === "assistant" && entry.text.trim() === "" && !entry.cut) out.push(nodeFor(entry, calls)); // hidden, and no break
			else {
				flush(true);
				out.push(nodeFor(entry, calls));
			}
		}
		flush(!state?.running); // the newest steps of work in hand stay as cards until it answers
		return out;
	}

	function nodeFor(entry, calls) {
		const existing = rendered.get(entry.id);
		if (existing) return existing;
		let node;
		if (entry.role === "divider") node = make("div", { className: "divider", textContent: entry.text });
		else if (entry.role === "notice") node = entry.card?.kind === "report" ? reportCard(entry.card) : make("div", { className: "notice-entry", textContent: entry.text });
		else if (entry.role === "user") node = bubble("msg user", entry.text, Array.from({ length: entry.images ?? 0 }, (_, n) => sentPhoto(entry, n)));
		else if (entry.role === "tool") node = toolCard(entry.name, calls.get(entry.callId), entry.summary, entry.text, entry.error, entry.diff);
		else {
			node = make("div", { className: "msg assistant" });
			renderMarkdown(node, entry.text, document);
			if (entry.cut) node.append(note("This answer was cut off."));
			if (entry.text.trim() === "" && !entry.cut) node.hidden = true; // a turn that only called tools: the cards say it
		}
		rendered.set(entry.id, node);
		return node;
	}

	function render() {
		const entries = [...known.values()].sort((a, b) => a.id - b.id);
		// Whether a run is going is part of the key: when it ends, its last steps fold.
		const key = `${entries.map((entry) => entry.id).join(",")}|${state?.running ? "working" : ""}`;
		const calls = new Map(); // call id -> the call, for its card
		for (const entry of entries) for (const call of entry.calls ?? []) calls.set(call.id, call);
		if (key !== drawn) {
			el.entries.replaceChildren(...threadNodes(entries, calls));
			drawn = key;
		}
		el.earlier.hidden = !moreEarlier;

		const live = [];
		for (const item of outbox.filter((kept) => (kept.c ?? "") === conversation)) {
			live.push(bubble("msg user unsent", item.text, (item.images ?? []).map((photo, n) => picture(n, sourceOf(photo)))));
			live.push(note(connection === "live" ? "Sending" : "Not sent yet", "note unsent-note"));
		}
		for (const ask of state?.approvals ?? []) {
			const card = make("div", { className: "approval" });
			const answer = (allow) => async () => {
				try {
					await api("approve", { id: ask.id, allow });
				} catch (error) {
					flash(error.message);
				}
			};
			const allow = make("button", { type: "button", className: "allow", textContent: "Allow" });
			const deny = make("button", { type: "button", textContent: "Deny" });
			allow.addEventListener("click", answer(true));
			deny.addEventListener("click", answer(false));
			const buttons = make("div", { className: "approval-buttons" });
			buttons.append(deny, allow);
			// What it would do, when rho could work that out (a release names the commits it brings in).
			const details = make("ul", { className: "approval-details" });
			details.append(...(ask.details ?? []).map((line) => make("li", { textContent: line })));
			// A worker's request says whose it is: the agent in this thread did not ask for it.
			card.append(...(ask.worker ? [note(`Worker ${ask.worker}`, "note approval-who")] : []), note(`Needs your yes: ${ask.what}`, "note approval-what"), make("pre", { textContent: ask.command }), ...(ask.details?.length ? [details] : []), buttons);
			live.push(card);
		}
		if (state?.running) {
			for (const tool of state.tools) {
				if (tool.status !== "done") live.push(Object.assign(toolCard(tool.name, calls.get(tool.id), runningWords(tool), tool.output.slice(-2000), false), { open: tool.output !== "" }));
			}
			if (state.partial) live.push(make("div", { className: "msg assistant streaming", textContent: state.partial }));
			else if (state.retry) live.push(note(`Trying again, attempt ${state.retry.attempt}`, "note working"));
			else if (!state.tools.some((tool) => tool.status !== "done")) live.push(note("Working", "note working"));
		} else if (state?.failure) {
			const text = state.failure.detail ? `${state.failure.text} ${state.failure.detail}` : state.failure.text;
			live.push(note(text, state.failure.reason === "aborted" ? "note" : "note failure"));
		}
		const running = runningCard();
		if (running) live.push(running);
		tickRunning();
		el.live.replaceChildren(...live);
		el.empty.hidden = entries.length > 0 || live.length > 0 || state === undefined;

		el.queue.replaceChildren(
			...(state?.queued ?? []).map((item) => {
				const row = make("li", {});
				const steer = item.mode === "steer";
				row.append(make("span", { className: "chip", textContent: steer ? "Steer · next step" : "Queued · after the answer" }));
				const words = [item.images ? count(item.images) : "", item.text].filter(Boolean).join(" · ");
				row.append(make("span", { className: "queued-text", textContent: words }));
				const flip = make("button", { type: "button", textContent: steer ? "Wait for the answer" : "Steer now" });
				flip.addEventListener("click", async () => {
					try {
						const { result } = await api("unqueue", { id: item.id });
						if (result === "aborted") submit(item.text, steer ? "followUp" : "steer"); // already taken by rho: nothing to move
					} catch (error) {
						flash(error.message);
					}
				});
				const remove = make("button", { type: "button", textContent: "Remove" });
				remove.setAttribute("aria-label", `Remove waiting message: ${words.slice(0, 60)}`);
				remove.addEventListener("click", async () => {
					try {
						const { result } = await api("unqueue", { id: item.id });
						if (result !== "aborted") return;
						if (el.input.value.trim() === "") setDraft(item.text); // give the words back
						if (item.images) flash(`Removed. Its ${count(item.images)} would need adding again.`);
					} catch (error) {
						flash(error.message);
					}
				});
				// The page no longer holds a waiting message's photos, so it cannot take it back and send it another way.
				row.append(...(item.images ? [remove] : [remove, flip]));
				return row;
			}),
		);

		if (!el.menu.hidden) syncMenu();
		renderStatus();
		renderSend();
		if (stick) el.thread.scrollTop = el.thread.scrollHeight;
		el.latest.hidden = stick;
	}

	// --- a release of new code into rho ------------------------------------------------------------
	const STAGES = { starting: "starting", fetch: "fetching the commit", check: "running the checks", "wait for idle": "waiting for rho to finish its answer", switch: "switching", restart: "restarting rho", "roll back": "going back" };
	const clock = (ms) => `${Math.floor(ms / 60_000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}`;
	let lastRelease; // the newest the daemon told; kept while rho is down, because the restart is part of the release
	let releaseTimer;
	/** The release line, or "" when there is nothing to say. */
	function releaseText() {
		const seen = state?.release ?? (connection === "live" ? undefined : lastRelease);
		if (!seen) return "";
		if (seen.status === "running") return `Releasing ${seen.commit} · ${STAGES[seen.stage] ?? seen.stage} · ${clock(Math.max(0, (env.now?.() ?? Date.now()) - (seen.started ?? seen.at)))}`;
		if (seen.status === "released") return `Rho now runs ${seen.commit} (it ran ${seen.previous}).`;
		if (seen.status === "rolled-back") return `${seen.commit} did not start, so rho is back on ${seen.previous}.`;
		return `${seen.commit} was not released. Rho still runs ${seen.previous}.`;
	}
	function renderRelease() {
		if (state?.release) lastRelease = state.release;
		else if (connection === "live") lastRelease = undefined; // the daemon is there and says there is none
		el.release.hidden = true; // the release is a row of the Running card, in the thread
	}

	// --- what is running -----------------------------------------------------------------------------
	// One card at the tail of the thread says what goes on beside the conversation: a release, the
	// background command, and each worker that is working, waiting or asking. A row is there while
	// its job is; when the job ends the row goes, and the report it leaves in the thread is the
	// record. Nothing sits outside the thread for them. The header counts what is live, and the
	// menu lists the workers that ended.
	const liveWorkers = () => (state?.workers ?? []).filter((worker) => worker.endedAt === undefined);
	const WORKER_WORDS = { waiting: "waiting for a slot", working: "working", asking: "needs your yes", done: "done", partial: "partial", failed: "failed", stopped: "stopped" };
	let runningTimer;
	let endedShown = false; // the ended workers, asked for from the menu; not kept
	function workerLine(worker) {
		const now = env.now?.() ?? Date.now();
		const ended = worker.endedAt !== undefined;
		const span = worker.startedAt === undefined ? "" : ` · ${clock(Math.max(0, (worker.endedAt ?? now) - worker.startedAt))}`;
		return `${WORKER_WORDS[worker.status] ?? worker.status}${span} · ${worker.place}${worker.model ? ` · ${worker.model.slice(worker.model.indexOf("/") + 1)}` : ""}${!ended && worker.step ? ` · ${worker.step}` : ""}`;
	}
	/** One row: what it is, how it stands, and a Stop when it can be stopped. */
	function runningRow(className, title, state, open, stop) {
		const row = make("li", { className: `running-row ${className}` });
		const name = make(open ? "button" : "span", { className: "running-title", textContent: title, ...(open ? { type: "button" } : {}) });
		if (open) name.addEventListener("click", open.go), name.setAttribute("aria-label", open.label);
		row.append(name, make("span", { className: "running-state", textContent: state }));
		if (stop) {
			const button = make("button", { type: "button", className: "running-stop", textContent: "Stop" });
			button.setAttribute("aria-label", stop.label);
			button.addEventListener("click", async () => {
				button.disabled = true;
				try {
					await api(stop.path, stop.body);
				} catch (error) {
					flash(error.message);
				}
			});
			row.append(button);
		}
		return row;
	}
	const workerRow = (worker) =>
		runningRow(
			`worker ${worker.status}${worker.endedAt !== undefined ? " ended" : ""}`,
			worker.title,
			workerLine(worker),
			worker.conversation === undefined ? undefined : { go: () => switchTo(worker.conversation, false), label: `Open the thread of worker ${worker.id}: ${worker.title}` },
			worker.endedAt === undefined ? { path: "workers/stop", body: { id: worker.id }, label: `Stop worker ${worker.id}` } : undefined,
		);
	/** The card, or nothing when nothing runs. Drawn after everything else in the thread. */
	function runningCard() {
		const now = env.now?.() ?? Date.now();
		const rows = [];
		const release = releaseText();
		if (release !== "") rows.push(runningRow(`release${/did not start|was not released/.test(release) ? " failed" : ""}`, "Release", release.replace(/^Releasing /, "")));
		const job = state?.background;
		if (job) rows.push(runningRow("background", job.command, `running · ${clock(Math.max(0, now - job.startedAt))} · background command`, undefined, { path: "background/stop", body: {}, label: "Stop the background command" }));
		const workers = state?.workers ?? [];
		rows.push(...liveWorkers().map(workerRow));
		// Asked for from the menu: the workers that ended in the last day, until the card is closed.
		const ended = endedShown ? workers.filter((worker) => worker.endedAt !== undefined) : [];
		rows.push(...ended.map(workerRow));
		if (rows.length === 0) return undefined;
		const card = make("section", { className: "running" });
		card.setAttribute("aria-label", "Running now");
		const head = make("div", { className: "running-head" });
		head.append(make("span", { textContent: ended.length > 0 && rows.length === ended.length ? "Ended today" : "Running" }));
		if (ended.length > 0) {
			const close = make("button", { type: "button", className: "running-close", textContent: "Hide ended" });
			close.addEventListener("click", () => {
				endedShown = false;
				render();
			});
			head.append(close);
		}
		const list = make("ul", {});
		list.append(...rows);
		card.append(head, list);
		return card;
	}
	/** The parts that are not in the thread: the worker thread's banner, the menu entry, and the clock that redraws the card. */
	function renderWorkers() {
		const workers = state?.workers ?? [];
		const thread = state?.workerThread;
		// In a worker's own thread: say whose it is, and how to go back. There is nothing to send there.
		el.workers.hidden = !thread;
		el.workerThread.hidden = !thread;
		if (thread) {
			const back = make("button", { type: "button", className: "worker-back", textContent: "Back" });
			back.addEventListener("click", () => switchTo(thread.from, thread.from === ""));
			el.workerThread.replaceChildren(document.createTextNode(`Worker ${thread.id}: ${thread.title}. Its thread is read only.`), back);
		}
		el.footer.hidden = Boolean(thread);
		const ended = workers.filter((worker) => worker.endedAt !== undefined).length;
		el.showWorkers.hidden = ended === 0 || endedShown;
		el.showWorkers.textContent = `Workers: ${ended} ended`;
		// The times count on between the daemon's snapshots.
		const counting = liveWorkers().some((worker) => worker.startedAt !== undefined) || Boolean(state?.background) || releaseText().startsWith("Releasing");
		if (counting && !runningTimer) runningTimer = setInterval(render, 1000);
		if (!counting && runningTimer) runningTimer = void clearInterval(runningTimer);
	}
	el.showWorkers.addEventListener("click", () => {
		endedShown = true;
		stick = true; // the card is at the tail: go to it
		closeMenu();
		render();
	});

	// --- a step that is running ----------------------------------------------------------------------
	// The daemon does not say when a call began, so the time is counted from when this page first
	// saw it running: right for a call watched from its start, short for one found already going.
	const began = new Map(); // call id -> when this page first saw it running
	let runTimer;
	/** "running · 0:32", with the newest line of its output when it has printed any. */
	function runningWords(tool) {
		const now = env.now?.() ?? Date.now();
		if (!began.has(tool.id)) began.set(tool.id, now);
		const last = tool.output.trimEnd().split("\n").at(-1)?.trim() ?? "";
		return `running · ${clock(now - began.get(tool.id))}${last ? ` · ${last.slice(0, 60)}` : ""}`;
	}
	/** While a step runs, its card's time counts on between the daemon's snapshots. */
	function tickRunning() {
		const going = (state?.running ? state.tools : []).filter((tool) => tool.status !== "done").map((tool) => tool.id);
		for (const id of [...began.keys()]) if (!going.includes(id)) began.delete(id);
		if (going.length > 0 && !runTimer) runTimer = setInterval(render, 1000);
		if (going.length === 0 && runTimer) runTimer = void clearInterval(runTimer);
	}

	let flashText = "";
	let flashTimer;
	function flash(text) {
		flashText = text;
		clearTimeout(flashTimer);
		flashTimer = setTimeout(() => {
			flashText = "";
			renderStatus();
		}, 6_000);
		renderStatus();
	}

	function renderStatus() {
		const words = { connecting: "Connecting", offline: "Can't reach rho", unpaired: "Not paired" };
		const queued = state?.queued?.length ?? 0;
		let text = words[connection];
		if (connection === "live") text = state?.running ? (queued > 0 ? `Working · ${queued} waiting` : "Working") : (state?.model ?? "Ready");
		// Workers still at it are counted beside it, whatever this thread itself is doing.
		const busy = liveWorkers().length + (state?.background ? 1 : 0);
		if (connection === "live" && busy > 0) text += ` · ${busy} running`;
		const restart = connection === "offline" && lastRelease?.status === "running";
		el.status.textContent = flashText || (restart ? "Restarting" : text);
		el.status.classList.toggle("warn", flashText !== "" || (connection === "offline" && !restart) || connection === "unpaired");
		// Connected, but this conversation's model cannot answer: say what to do about it.
		const setup = connection === "live" ? (state?.setup ?? "") : "";
		renderRelease();
		renderWorkers();
		// Rho going away in the middle of a release is the restart, not a fault: the release line says so.
		const restarting = connection === "offline" && lastRelease?.status === "running";
		el.notice.hidden = restarting || (connection !== "offline" && connection !== "unpaired" && setup === "");
		el.noticeText.textContent = setup !== "" ? setup : connection === "unpaired"
			? "This browser is not paired. On the machine rho runs on, run: rho open"
			: outbox.length > 0 ? "Can't reach rho. Your message is kept and sends when it is back." : "Can't reach rho.";
		if (el.newChat) el.newChat.textContent = "Clear context";
	}

	function renderSend() {
		const hasWords = el.input.value.trim() !== "" || chosen.length > 0 || reading > 0;
		const stop = Boolean(state?.running) && !hasWords;
		el.send.textContent = stop ? "Stop" : "Send";
		el.send.setAttribute("aria-label", stop ? "Stop" : state?.running ? "Send to the work in hand" : "Send");
		el.send.classList.toggle("stop", stop);
		el.send.disabled = reading > 0 || (!stop && !hasWords); // a photo still being read would be left behind
	}

	// --- photos ----------------------------------------------------------------------------------
	function renderChosen() {
		el.photos.replaceChildren(
			...chosen.map((photo, n) => {
				const row = make("li", {});
				const remove = make("button", { type: "button", textContent: "Remove" });
				remove.setAttribute("aria-label", `Remove photo ${n + 1}`);
				remove.addEventListener("click", () => {
					chosen = chosen.filter((kept) => kept !== photo);
					renderChosen();
				});
				row.append(picture(n, sourceOf(photo)), remove);
				return row;
			}),
		);
		renderSend();
	}
	async function addPhotos(files) {
		for (const file of files) {
			if (chosen.length + reading >= MAX_PHOTOS) {
				flash(`A message takes up to ${MAX_PHOTOS} photos.`);
				break;
			}
			// A picker that names no type is believed; the daemon reads the bytes either way.
			if (file.type !== "" && !PHOTO_TYPE.test(file.type)) {
				flash("That is not a JPEG, PNG, GIF or WebP picture.");
				continue;
			}
			reading++;
			renderSend();
			try {
				// A camera photo is made smaller here, where the device does it in a moment; the daemon
				// can do it too, but slowly. If that fails the photo goes as it is.
				const ready = (await env.shrink?.(file).catch(() => undefined)) ?? file;
				if (ready.size > MAX_PHOTO_BYTES) {
					flash(`That photo is too large: the most is ${MAX_PHOTO_BYTES / 1024 / 1024} MB.`);
					continue;
				}
				const data = toBase64(new Uint8Array(await ready.arrayBuffer()));
				if (chosen.reduce((sum, photo) => sum + photo.data.length, data.length) > MAX_UPLOAD_CHARS) flash("Those photos are too large to send together. Send fewer at a time.");
				else chosen = [...chosen, { type: ready.type || file.type || "image/jpeg", data }];
			} catch {
				flash("That photo could not be read.");
			} finally {
				reading--;
			}
		}
		renderChosen();
	}
	el.attach.addEventListener("click", () => el.photoInput.click());
	el.photoInput.addEventListener("change", async () => {
		const files = [...(el.photoInput.files ?? [])];
		el.photoInput.value = ""; // so the same photo can be picked again
		await addPhotos(files);
	});
	el.input.addEventListener("paste", async (event) => {
		const files = [...(event.clipboardData?.files ?? [])].filter((file) => file.type.startsWith("image/"));
		if (files.length === 0) return; // pasted words go the usual way
		event.preventDefault();
		await addPhotos(files);
	});

	// --- composer --------------------------------------------------------------------------------
	let nextMode = "steer";
	function grow() {
		el.input.style.height = "auto";
		el.input.style.height = `${el.input.scrollHeight + 2}px`;
	}
	function setDraft(text) {
		el.input.value = text;
		store.set("draft", text);
		grow();
		renderSend();
	}
	el.input.addEventListener("input", () => {
		store.set("draft", el.input.value);
		grow();
		renderSend();
	});
	el.input.addEventListener("keydown", (event) => {
		// On a touch keyboard Enter is a new line and the button sends. An IME's Enter never sends.
		if (event.key !== "Enter" || event.shiftKey || env.touch || event.isComposing || event.keyCode === 229) return;
		event.preventDefault();
		if (event.altKey) nextMode = "followUp"; // Alt+Enter: wait for the answer
		el.composer.requestSubmit();
	});
	el.composer.addEventListener("submit", async (event) => {
		event.preventDefault();
		const text = el.input.value.trim();
		if (reading > 0) return;
		if (text === "" && chosen.length === 0) {
			if (!state?.running) return;
			try {
				await api("stop", {});
			} catch (error) {
				flash(error.message);
			}
			return;
		}
		const images = chosen;
		chosen = [];
		renderChosen();
		setDraft("");
		submit(text, nextMode, images);
		nextMode = "steer";
	});

	// --- thread ----------------------------------------------------------------------------------
	el.thread.addEventListener("scroll", () => {
		stick = el.thread.scrollHeight - el.thread.scrollTop - el.thread.clientHeight < 60;
		el.latest.hidden = stick;
	});
	el.latest.addEventListener("click", () => {
		stick = true;
		el.thread.scrollTop = el.thread.scrollHeight;
		el.latest.hidden = true;
	});
	el.earlier.addEventListener("click", async () => {
		const oldest = Math.min(...known.keys());
		const height = el.thread.scrollHeight;
		try {
			const page = await api(`earlier?before=${oldest}`);
			for (const entry of page.entries) known.set(entry.id, entry);
			moreEarlier = page.more;
			stick = false;
			render();
			el.thread.scrollTop += el.thread.scrollHeight - height; // keep the sentence being read in place
		} catch (error) {
			flash(error.message);
		}
	});

	// --- conversations ---------------------------------------------------------------------------
	function switchTo(id, root) {
		conversation = root ? "" : id;
		store.set("conversation", conversation);
		state = undefined;
		known.clear();
		rendered.clear();
		folded.clear();
		drawn = undefined; // not "": an empty thread must still replace what was drawn
		moreEarlier = false;
		stick = true;
		closeMenu();
		render();
		void stream();
	}
	async function listConversations() {
		try {
			const { items } = await api("conversations");
			el.conversations.replaceChildren(
				...items.map((item) => {
					const open = make("button", { type: "button", className: "conversation" });
					const current = item.root ? conversation === "" : conversation === item.id;
					if (current) open.setAttribute("aria-current", "true");
					open.append(make("span", { className: "conversation-title", textContent: item.title || "New conversation" }), make("span", { className: "conversation-where", textContent: `${item.running ? "Working · " : ""}${item.cwd ?? ""}` }));
					open.addEventListener("click", () => switchTo(item.id, item.root));
					const row = make("li", {});
					row.append(open);
					return row;
				}),
			);
		} catch (error) {
			flash(error.message);
		}
	}
	el.newConversation.addEventListener("click", async () => {
		try {
			const { id } = await api("conversations", state?.cwd ? { cwd: state.cwd } : {}); // it starts where this one works
			switchTo(id, false);
		} catch (error) {
			flash(error.message);
		}
	});

	// --- menu ------------------------------------------------------------------------------------
	function syncMenu() {
		for (const option of el.thinking.children) option.selected = option.value === state?.thinking;
		for (const option of el.model.children) option.selected = option.value === state?.model;
	}
	function closeMenu() {
		el.menu.hidden = true;
		el.menuButton.setAttribute("aria-expanded", "false");
	}
	el.menuButton.addEventListener("click", async () => {
		if (!el.menu.hidden) return closeMenu();
		el.menu.hidden = false;
		el.menuButton.setAttribute("aria-expanded", "true");
		el.thinking.replaceChildren(...THINKING.map((level) => make("option", { value: level, textContent: level, selected: level === state?.thinking })));
		void listConversations();
		try {
			const { items } = await api("models");
			el.model.replaceChildren(...items.map((model) => make("option", { value: model.id, textContent: model.name, selected: model.id === state?.model })));
		} catch (error) {
			flash(error.message);
		}
	});
	document.addEventListener("keydown", (event) => {
		if (event.key === "Escape") closeMenu();
	});
	document.addEventListener("click", (event) => {
		if (!el.menu.hidden && !el.menu.contains(event.target) && event.target !== el.menuButton) closeMenu();
	});
	const choose = (field) => async () => {
		try {
			await api("model", { [field]: el[field].value });
		} catch (error) {
			flash(error.message);
		}
	};
	el.model.addEventListener("change", choose("model"));
	el.thinking.addEventListener("change", choose("thinking"));
	el.newChat.addEventListener("click", async () => {
		closeMenu();
		try {
			await api("new", {});
		} catch (error) {
			flash(error.message);
		}
	});

	// --- start -----------------------------------------------------------------------------------
	document.addEventListener("visibilitychange", () => {
		// A phone freezes a hidden page. On return, drop the old read and take a fresh snapshot.
		if ((env.visible?.() ?? document.visibilityState === "visible") && !stopped) void stream();
	});
	renderStatus();
	const ready = pair().then(() => {
		setDraft(store.get("draft", ""));
		if (lostPhotos.length > 0) flash("A message with photos was not sent before the page closed. Add the photos again.");
		void stream();
	});
	return {
		ready,
		stop() {
			stopped = true;
			streamAbort?.abort();
			clearTimeout(flashTimer);
			clearInterval(releaseTimer);
			clearInterval(runTimer);
			clearInterval(runningTimer);
		},
	};
}
