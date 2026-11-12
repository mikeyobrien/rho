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
 * Start the page. `env` is what it touches of the browser: `document`, `window`, `storage` (localStorage),
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
		menuButton: $("menu-button"), title: $("title"), details: $("details"), detailsBack: $("details-back"), detailsTitle: $("details-title"), detailsBody: $("details-body"), detailsNotice: $("details-notice"),
		attach: $("attach"), photoInput: $("photo-input"), photos: $("photos"), release: $("release"), releaseText: $("release-text"),
		workers: $("workers"), workerThread: $("worker-thread"), footer: $("composer"),
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
		// The title names the job; an id ("worker w6", on a card stored before) means nothing to the person.
		second.append(make("span", { className: "report-summary", textContent: brief }), make("span", { className: "report-who", textContent: card.who.replace(/^worker w\d+$/, "worker") }));
		head.append(top, second);
		node.append(head);
		if (card.body || card.decided?.length) {
			const body = make("div", { className: "report-body" });
			if (card.decided?.length) {
				// What the worker's questions came to, without the person: one line that opens.
				const fold = make("details", { className: "report-decided" });
				fold.append(make("summary", { textContent: `Decided without you · ${card.decided.length}` }));
				const BY_WORDS = { coordinator: "answered by rho", person: "your answer", default: "the worker's default" };
				for (const entry of card.decided) {
					const row = make("div", { className: "decided-row" });
					row.append(make("div", { className: "decided-question", textContent: entry.question }), make("div", { className: "decided-done", textContent: `→ ${entry.done}` }), make("div", { className: "decided-basis", textContent: `${BY_WORDS[entry.by] ?? entry.by} · ${entry.basis}` }));
					fold.append(row);
				}
				body.append(fold);
			}
			if (card.body) {
				const words = make("div", {});
				renderMarkdown(words, card.body, document);
				body.append(words);
			}
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
	const photoCache = new Map(); // conversation:entry:n -> the asked-for picture, so the thread and the details page ask once
	function photoOf(id, n) {
		const key = `${conversation}:${id}:${n}`;
		if (!photoCache.has(key)) {
			const asked = api(`image?entry=${id}&n=${n}`);
			photoCache.set(key, asked);
			asked.catch(() => photoCache.delete(key)); // a failure is asked again the next time it is drawn
		}
		return photoCache.get(key);
	}
	function sentPhoto(entry, n, className = "photo") {
		const img = Object.assign(picture(n), { className });
		photoOf(entry.id, n).then(
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
		else if (entry.role === "notice") node = entry.card?.kind === "report" ? reportCard(entry.card) : entry.from === "worker-ask" ? make("div", { className: "notice-entry quiet", textContent: (entry.text.split("\n")[0] ?? "").replace(/^\[a worker asks\]\s*/, "A worker asks rho · ") }) : make("div", { className: "notice-entry", textContent: entry.text });
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
			card.append(...(ask.worker ? [note(`${ask.worker.replace(/^w\d+: /, "")} · a worker`, "note approval-who")] : []), note(`Needs your yes: ${ask.what}`, "note approval-what"), make("pre", { textContent: ask.command }), ...(ask.details?.length ? [details] : []), buttons);
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
		return ""; // over: the gate's message in the thread says how it ended
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
	// details page lists every worker, ended ones too.
	const liveWorkers = () => (state?.workers ?? []).filter((worker) => worker.endedAt === undefined);
	const WORKER_WORDS = { waiting: "waiting for a slot", working: "working", asking: "needs your yes", done: "done", partial: "partial", failed: "failed", stopped: "stopped" };
	let runningTimer;
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
			worker.conversation === undefined ? undefined : { go: () => switchTo(worker.conversation, false), label: `Open the worker's thread: ${worker.title}` },
			worker.endedAt === undefined ? { path: "workers/stop", body: { id: worker.id }, label: `Stop the worker: ${worker.title}` } : undefined,
		);
	/** The card, or nothing when nothing runs. Drawn after everything else in the thread. */
	function runningCard() {
		const now = env.now?.() ?? Date.now();
		const rows = [];
		// A release is a row only while it is under way. How it ended is the gate's message in the
		// thread, which stays; a finished release under "Running" reads as one that is stuck.
		const release = releaseText();
		if (release.startsWith("Releasing")) rows.push(runningRow("release", "Release", release.replace(/^Releasing /, "")));
		const job = state?.background;
		if (job) rows.push(runningRow("background", job.command, `running · ${clock(Math.max(0, now - job.startedAt))} · background command`, undefined, { path: "background/stop", body: {}, label: "Stop the background command" }));
		rows.push(...liveWorkers().map(workerRow));
		if (rows.length === 0) return undefined;
		const card = make("section", { className: "running" });
		card.setAttribute("aria-label", "Running now");
		const head = make("div", { className: "running-head" });
		head.append(make("span", { textContent: "Running" }));
		const list = make("ul", {});
		list.append(...rows);
		card.append(head, list);
		return card;
	}
	/** The parts that are not in the thread: the worker thread's banner, and the clock that redraws the card. */
	function renderWorkers() {
		const thread = state?.workerThread;
		// In a worker's own thread: say whose it is, and how to go back. There is nothing to send there.
		el.workers.hidden = !thread;
		el.workerThread.hidden = !thread;
		if (thread) {
			const back = make("button", { type: "button", className: "worker-back", textContent: "Back" });
			back.addEventListener("click", () => switchTo(thread.from, thread.from === ""));
			el.workerThread.replaceChildren(document.createTextNode(`${thread.title}: a worker's thread, read only.`), back);
		}
		el.footer.hidden = Boolean(thread);
		// The times count on between the daemon's snapshots.
		const counting = liveWorkers().some((worker) => worker.startedAt !== undefined) || Boolean(state?.background) || releaseText().startsWith("Releasing");
		if (counting && !runningTimer) runningTimer = setInterval(render, 1000);
		if (!counting && runningTimer) runningTimer = void clearInterval(runningTimer);
	}

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
		drawDetails(); // it repeats the status line, and counts what the state holds
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
	el.earlier.addEventListener("click", () => loadEarlier());
	async function loadEarlier() {
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
	}
	/** Leave the details page and bring one entry of the thread into view, opened: out of its fold, and marked for a moment. */
	let jumpTimer;
	function jumpTo(id) {
		closeDetails();
		const node = rendered.get(id);
		if (!node) return;
		for (const fold of folded.values()) if (fold.key.split(",").includes(String(id))) fold.node.open = true;
		if (node.tagName === "DETAILS") node.open = true; // a tool card or a report: shown opened
		stick = false; // the reader is taken to this place: the next snapshot must not take them to the end
		el.latest.hidden = false;
		node.scrollIntoView?.({ block: "center" });
		node.classList.toggle("jumped", true);
		clearTimeout(jumpTimer);
		jumpTimer = setTimeout(() => node.classList.toggle("jumped", false), 2_000);
	}

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
		info = { commit: info.commit, models: info.models }; // the rest was the other conversation's
		closeDetails();
		render();
		void stream();
	}
	// --- details ---------------------------------------------------------------------------------
	// One page over the thread, as a chat app's info screen: a header block, then rows; a row opens
	// a list, and back returns. The thread under it is not touched, so its place is kept. Each
	// level is a step of the browser's history, so the back gesture closes a level and does not
	// leave the page. Which level is open is kept only in this page: a reload shows the thread.
	const pops = Boolean(env.window && history.pushState && history.go);
	let trail = []; // the open levels, innermost last; none when the page is closed
	let skipPops = 0; // history steps this page took back itself: their events are not the person's
	let info = {}; // what the page asked the daemon for when it opened: the commit, the lists
	let detailsKey; // what is drawn, so a snapshot that changes none of it moves nothing under a finger
	let optionsFor; // the model list the picker was last filled from
	const UNDER = [$("top"), el.thread, $("bottom"), el.latest];
	let ticks = []; // what the open level writes again each second without being rebuilt: a worker's time
	const picker = (id, label) => {
		const select = make("select", { id });
		select.setAttribute("aria-label", label);
		select.addEventListener("change", async () => {
			try {
				await api("model", { [id]: select.value });
			} catch (error) {
				flash(error.message);
			}
		});
		return select;
	};
	const modelSelect = picker("model", "Model");
	const thinkingSelect = picker("thinking", "Thinking");
	thinkingSelect.replaceChildren(...THINKING.map((level) => make("option", { value: level, textContent: level })));
	function syncPickers() {
		if (info.models && info.models !== optionsFor) {
			optionsFor = info.models;
			modelSelect.replaceChildren(...info.models.map((model) => make("option", { value: model.id, textContent: model.name })));
		}
		for (const option of thinkingSelect.children) option.selected = option.value === state?.thinking;
		for (const option of modelSelect.children) option.selected = option.value === state?.model;
		modelSelect.disabled = thinkingSelect.disabled = Boolean(state?.workerThread);
	}
	const quiet = (text) => make("p", { className: "quiet-line", textContent: text });
	const heading = (text) => make("h3", { className: "section-label", textContent: text });
	const rows = (items) => {
		const list = make("ul", { className: "rows" });
		list.append(...items);
		return list;
	};
	/** A row that does something: a button with a title, a quiet second line, a value at the right, and beside it an action of its own. */
	function row({ title, sub = "", value = "", go, label, current = false, chevron = true, action, kind = "" }) {
		const item = make("li", { className: kind === "" ? "row-line" : `row-line ${kind}` });
		const main = make("span", { className: "row-main" });
		// A second line that counts time is given as a function, and is written again in place between drawings.
		const second = make("span", { className: "row-sub", textContent: typeof sub === "function" ? sub() : sub });
		if (typeof sub === "function") ticks.push(() => (second.textContent = sub()));
		main.append(make("span", { className: "row-title", textContent: title }), ...(sub === "" ? [] : [second]));
		const mark = make("span", { className: "row-chevron", textContent: "›" });
		mark.setAttribute("aria-hidden", "true");
		const parts = [main, ...(value === "" ? [] : [make("span", { className: "row-value", textContent: String(value) })]), ...(chevron && go ? [mark] : [])];
		const body = make(go ? "button" : "div", { className: "row", ...(go ? { type: "button" } : {}) });
		body.append(...parts);
		if (go) body.addEventListener("click", go);
		if (label) body.setAttribute("aria-label", label);
		if (current) body.setAttribute("aria-current", "true");
		item.append(body, ...(action ? [action] : []));
		return item;
	}
	/** A row of words to read, whole: it wraps and opens nothing. */
	const textRow = (text) => {
		const item = make("li", { className: "row-line" });
		item.append(make("div", { className: "row-text", textContent: text }));
		return item;
	};
	const shortModel = () => (state?.model ? state.model.slice(state.model.indexOf("/") + 1) : "");

	// The sections, in the order of the page. `value` is what the row shows at its right: a count, or a word.
	const MEMORY_LISTS = [["user", "About you"], ["notes", "Rho's notes"], ["models", "Model preferences"]];
	const SECTIONS = [
		{ id: "workers", title: "Workers", sub: () => (liveWorkers().length > 0 ? `${liveWorkers().length} running` : "Jobs rho handed off"), value: () => allWorkers().length, data: () => [state?.conversation, allWorkers()], draw: drawWorkers },
		{ id: "artifacts", title: "Artifacts", sub: "Photos, files changed, reports", value: () => { const found = artifacts(); return found.photos.length + found.files.length + found.reports.length; }, data: () => [conversation, artifacts(), moreEarlier], draw: drawArtifacts },
		{ id: "memory", title: "Preferences and memory", sub: "What rho knows about you", value: () => (info.memory ? (info.memory.lists ? MEMORY_LISTS.reduce((sum, [name]) => sum + (info.memory.lists[name]?.length ?? 0), 0) : info.memory.provider === "off" ? "off" : "elsewhere") : ""), data: () => [info.memory], draw: drawMemory },
		{ id: "reminders", title: "Reminders", sub: "What rho checks on its own", value: () => info.reminders?.length ?? "", data: () => [info.reminders], draw: drawReminders },
		{ id: "settings", title: "Settings", sub: "Model, thinking, context", value: () => shortModel(), data: () => [state?.cwd, Boolean(state?.workerThread)], draw: drawSettings },
		{ id: "conversations", title: "Conversations", sub: "Open another, or start one", value: () => info.conversations?.length ?? "", data: () => [conversation, info.conversations], draw: drawConversations },
	];
	function drawMain() {
		const head = make("div", { className: "details-head" });
		const thread = state?.workerThread;
		head.append(
			make("p", { className: "details-name", textContent: "rho" }),
			make("p", { className: "details-status", textContent: el.status.textContent }),
			...(thread ? [make("p", { className: "details-line", textContent: `${thread.title}: a worker's thread, read only.` })] : []),
			...(info.commit ? [make("p", { className: "details-line details-commit", textContent: `Commit ${info.commit.slice(0, 7)}` })] : []),
			...(state?.cwd ? [make("p", { className: "details-line details-cwd", textContent: state.cwd })] : []),
		);
		return [head, rows(SECTIONS.map((section) => row({ title: section.title, sub: subOf(section), value: section.value(), go: () => showView(section.id) })))];
	}
	const pad = (n) => String(n).padStart(2, "0");
	const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
	/** A time of day, with the date when it is not today. */
	function when(ms) {
		const [then, now] = [new Date(ms), new Date(env.now?.() ?? Date.now())];
		const time = `${pad(then.getHours())}:${pad(then.getMinutes())}`;
		if (then.toDateString() === now.toDateString()) return time;
		return `${then.getDate()} ${MONTHS[then.getMonth()]}${then.getFullYear() === now.getFullYear() ? "" : ` ${then.getFullYear()}`} ${time}`;
	}
	/**
	 * Every worker of this conversation the daemon still knows: the state's (fresh, with the step
	 * it is on) over the list asked for when the page opened, which also holds those that ended
	 * more than a day ago. Live ones first, then the newest first.
	 */
	function allWorkers() {
		const byId = new Map();
		for (const worker of (info.workers ?? []).filter((item) => item.from === state?.conversation)) byId.set(worker.id, worker);
		for (const worker of state?.workers ?? []) byId.set(worker.id, worker);
		const live = (worker) => worker.endedAt == null;
		return [...byId.values()].sort((a, b) => Number(live(b)) - Number(live(a)) || b.createdAt - a.createdAt);
	}
	const workerWhen = (worker) => (worker.endedAt != null ? `ended ${when(worker.endedAt)}` : worker.startedAt != null ? `started ${when(worker.startedAt)}` : `asked ${when(worker.createdAt)}`);
	function drawWorkers() {
		const items = allWorkers().map((found) => {
			// The list the daemon answers with writes "none" as null; the state leaves it out.
			const worker = Object.fromEntries(Object.entries(found).filter(([, value]) => value !== null));
			const stop = make("button", { type: "button", className: "row-action", textContent: "Stop" });
			stop.setAttribute("aria-label", `Stop the worker: ${worker.title}`);
			stop.addEventListener("click", async () => {
				stop.disabled = true;
				try {
					await api("workers/stop", { id: worker.id });
				} catch (error) {
					flash(error.message);
				}
				void loadInfo(["workers"]);
			});
			return row({
				title: worker.title,
				sub: () => `${workerLine(worker)} · ${workerWhen(worker)}`,
				kind: `worker ${worker.status}`,
				go: worker.conversation === undefined ? undefined : () => switchTo(worker.conversation, false),
				action: worker.endedAt === undefined ? stop : undefined,
			});
		});
		return [...(items.length > 0 ? [rows(items)] : [quiet("No workers yet in this conversation.")]), quiet("A worker is a job rho handed off, in its own thread. Tap one to read its thread. How each ended is a report card in this thread.")];
	}
	/**
	 * What the conversation produced or received, read from the entries this page holds: the photos
	 * the person sent, the files an edit or a write changed (a call that failed changed nothing),
	 * and the reports of side work. Rho keeps no list of these; this is what the thread shows.
	 */
	function artifacts() {
		const entries = [...known.values()].sort((a, b) => a.id - b.id);
		const calls = new Map();
		for (const entry of entries) for (const call of entry.calls ?? []) calls.set(call.id, call);
		const photos = [];
		const files = new Map(); // path -> { path, count, id, last }: insertion order is oldest change first
		const reports = [];
		for (const entry of entries) {
			if (entry.role === "user") for (let n = 0; n < (entry.images ?? 0); n++) photos.push({ id: entry.id, n });
			if (entry.role === "notice" && entry.card?.kind === "report") reports.push({ id: entry.id, verdict: entry.card.verdict, title: entry.card.title, who: entry.card.who.replace(/^worker w\d+$/, "worker") });
			if (entry.role !== "tool" || entry.error || (entry.name !== "edit" && entry.name !== "write")) continue;
			const given = calls.get(entry.callId)?.args?.path;
			if (typeof given !== "string" || given === "") continue;
			// The same file, named from the working directory or in full, is one row.
			const path = state?.cwd && given.startsWith(`${state.cwd}/`) ? given.slice(state.cwd.length + 1) : given;
			const count = (files.get(path)?.count ?? 0) + 1;
			files.delete(path);
			files.set(path, { path, count, id: entry.id, last: entry.summary });
		}
		return { photos: photos.reverse(), files: [...files.values()].reverse(), reports: reports.reverse() };
	}
	function drawArtifacts() {
		const found = artifacts();
		const out = [quiet(moreEarlier ? "This covers the messages loaded so far. Earlier ones are not counted yet." : "This covers every message of the conversation.")];
		if (moreEarlier) {
			const more = make("button", { type: "button", id: "artifacts-earlier", textContent: "Load earlier" });
			more.addEventListener("click", async () => {
				more.disabled = true;
				await loadEarlier();
			});
			out.push(more);
		}
		out.push(heading(`Photos · ${found.photos.length}`));
		if (found.photos.length === 0) out.push(quiet("No photos sent."));
		else {
			const grid = make("ul", { className: "thumbs" });
			grid.append(
				...found.photos.map((photo) => {
					const open = make("button", { type: "button", className: "thumb" });
					open.setAttribute("aria-label", `Go to the message with photo ${photo.n + 1}`);
					open.append(sentPhoto(photo, photo.n, "thumb-img"));
					open.addEventListener("click", () => jumpTo(photo.id));
					const cell = make("li", {});
					cell.append(open);
					return cell;
				}),
			);
			out.push(grid);
		}
		out.push(heading(`Files changed · ${found.files.length}`));
		out.push(found.files.length === 0 ? quiet("No files changed.") : rows(found.files.map((file) => row({ title: file.path, sub: `${file.count === 1 ? "1 change" : `${file.count} changes`} · last ${file.last}`, kind: "file", go: () => jumpTo(file.id), label: `Go to the last change of ${file.path}` }))));
		out.push(heading(`Reports · ${found.reports.length}`));
		out.push(found.reports.length === 0 ? quiet("No reports.") : rows(found.reports.map((report) => row({ title: report.title, sub: `${VERDICT_WORDS[report.verdict] ?? report.verdict} · ${report.who}`, kind: `report-row ${report.verdict}`, go: () => jumpTo(report.id) }))));
		return out;
	}
	function drawMemory() {
		const memory = info.memory;
		if (!memory) return [quiet("Loading")];
		// Another provider, or none: the daemon says which in words, and there are no lists to draw.
		if (!memory.lists) return [quiet(memory.note ?? "There is nothing to list here.")];
		const out = [quiet("Rho reads these at the start of a conversation. To change one, tell rho in chat.")];
		for (const [name, title] of MEMORY_LISTS) {
			const entries = memory.lists[name] ?? [];
			out.push(heading(`${title} · ${entries.length}`), entries.length === 0 ? quiet("Nothing yet.") : rows(entries.map(textRow)));
		}
		return out;
	}
	const UNITS = [["d", 86_400_000], ["h", 3_600_000], ["m", 60_000]];
	function cadenceWords(cadence) {
		if (cadence.kind === "once") return "once";
		if (cadence.kind === "daily") return `daily at ${cadence.at}`;
		const [unit, size] = UNITS.find(([, ms]) => cadence.everyMs % ms === 0) ?? UNITS[2];
		return `every ${cadence.everyMs / size}${unit}`;
	}
	function drawReminders() {
		const items = (info.reminders ?? []).map((item) => {
			// Removing cannot be taken back, so it takes two taps: the button asks once.
			let sure = false;
			const remove = make("button", { type: "button", className: "row-action", textContent: "Remove" });
			remove.setAttribute("aria-label", `Remove reminder: ${item.text.slice(0, 60)}`);
			remove.addEventListener("click", async () => {
				if (!sure) {
					sure = true;
					Object.assign(remove, { className: "row-action sure", textContent: "Remove now" });
					remove.setAttribute("aria-label", `Remove now, for good: ${item.text.slice(0, 60)}`);
					return;
				}
				remove.disabled = true;
				try {
					await api("reminders/remove", { id: item.id });
				} catch (error) {
					flash(error.message);
				}
				await loadInfo(["reminders"]);
			});
			return row({ title: item.text, sub: `${cadenceWords(item.cadence)} · next ${when(item.nextDue)}`, kind: "wrap", action: remove });
		});
		return [...(items.length > 0 ? [rows(items)] : [quiet(info.reminders ? "No reminders." : "Loading")]), quiet("Reminders are rho's, not one conversation's: what it finds is said in the first conversation. Tell rho in chat to add or change one.")];
	}
	function drawSettings() {
		const fields = make("div", { className: "fields" });
		const clear = make("button", { type: "button", id: "new-chat", textContent: "Clear context", disabled: Boolean(state?.workerThread) });
		clear.addEventListener("click", async () => {
			closeDetails();
			try {
				await api("new", {});
			} catch (error) {
				flash(error.message);
			}
		});
		fields.append(
			make("label", { htmlFor: "model", textContent: "Model" }), modelSelect,
			make("label", { htmlFor: "thinking", textContent: "Thinking" }), thinkingSelect,
			heading("Working directory"), make("p", { className: "field-value", id: "cwd", textContent: state?.cwd ?? "Not set" }),
			quiet("This conversation's tools work here. A new conversation starts in the same place."),
			clear,
			quiet("Clear context starts over in this conversation. The messages stay in the thread, above a line."),
		);
		return [fields];
	}
	function drawConversations() {
		const items = (info.conversations ?? []).map((item) =>
			row({
				title: item.title || "New conversation",
				sub: `${item.running ? "Working · " : ""}${item.cwd ?? ""}`,
				current: item.root ? conversation === "" : conversation === item.id,
				chevron: false,
				go: () => switchTo(item.id, item.root),
			}),
		);
		const fresh = make("button", { type: "button", id: "new-conversation", textContent: "New conversation" });
		fresh.addEventListener("click", async () => {
			try {
				const { id } = await api("conversations", state?.cwd ? { cwd: state.cwd } : {}); // it starts where this one works
				switchTo(id, false);
			} catch (error) {
				flash(error.message);
			}
		});
		return [...(items.length > 0 ? [rows(items)] : [quiet(info.conversations ? "No conversations." : "Loading")]), fresh];
	}
	const viewOf = (id) => SECTIONS.find((section) => section.id === id);
	/** What the open level shows: when it is the same as what is drawn, nothing is rebuilt, so a picker that is open stays open. */
	const mainData = () => [el.status.textContent, state?.cwd, state?.workerThread, info.commit, SECTIONS.map((section) => [section.value(), subOf(section)])];
	const subOf = (section) => (typeof section.sub === "function" ? section.sub() : section.sub);
	function drawDetails(moved = false) {
		const view = trail.at(-1);
		el.details.hidden = view === undefined;
		// What is under the page is out of reach while it is open: not tabbed into, not read out.
		for (const under of UNDER) under.inert = view !== undefined;
		// What went wrong is said on the page too: the status line is under it.
		el.detailsNotice.textContent = flashText;
		el.detailsNotice.hidden = flashText === "";
		el.menuButton.setAttribute("aria-expanded", view === undefined ? "false" : "true");
		if (view === undefined) return void ((detailsKey = undefined), (ticks = []));
		syncPickers();
		const key = JSON.stringify([view, view === "main" ? mainData() : viewOf(view).data()]);
		if (key === detailsKey) for (const tick of ticks) tick();
		else {
			detailsKey = key;
			ticks = [];
			el.detailsTitle.textContent = view === "main" ? "Details" : viewOf(view).title;
			el.detailsBack.setAttribute("aria-label", view === "main" ? "Back to the conversation" : "Back to details");
			el.detailsBody.replaceChildren(...(view === "main" ? drawMain() : viewOf(view).draw()));
		}
		if (moved) el.detailsBack.focus?.();
	}
	/** Ask the daemon for what the state does not carry. Each answer is drawn as it comes; one that fails leaves its list as it was. */
	const SOURCES = [["commit", "health", (data) => data.commit ?? ""], ["conversations", "conversations", (data) => data.items], ["models", "models", (data) => data.items], ["workers", "workers", (data) => data.items], ["reminders", "reminders", (data) => data.items], ["memory", "memory", (data) => data]];
	let loading = 0;
	const busy = () => el.detailsBody.setAttribute("aria-busy", loading > 0 ? "true" : "false");
	async function loadInfo(names = SOURCES.map(([name]) => name)) {
		loading++;
		busy();
		await Promise.all(
			SOURCES.filter(([name]) => names.includes(name)).map(async ([name, path, pick]) => {
				try {
					const value = pick(await api(path));
					info = { ...info, [name]: value }; // read after the wait: the answers come in any order
				} catch (error) {
					flash(error.message);
				}
				drawDetails();
			}),
		);
		loading--;
		busy();
	}
	function showView(view) {
		trail = [...trail, view];
		if (pops) history.pushState({ details: view }, "");
		drawDetails(true);
	}
	function openDetails() {
		if (trail.length > 0) return;
		showView("main");
		void loadInfo();
	}
	/** One level back: to the list of sections, or to the thread. */
	function popView() {
		trail = trail.slice(0, -1);
		drawDetails(true);
		if (trail.length === 0) el.menuButton.focus?.();
	}
	/** The page's own back button and Escape: the same step as the browser's back. */
	function stepBack() {
		if (trail.length === 0) return;
		if (pops) history.back();
		else popView();
	}
	/** Close every level at once, for a row that leads back into the thread. */
	function closeDetails() {
		const levels = trail.length;
		if (levels === 0) return;
		trail = [];
		drawDetails();
		el.menuButton.focus?.();
		if (pops) {
			skipPops++;
			history.go(-levels);
		}
	}
	env.window?.addEventListener("popstate", () => {
		if (skipPops > 0) return void skipPops--;
		if (trail.length > 0) popView(); // after a reload nothing is open, and back is the browser's own
	});
	el.menuButton.addEventListener("click", openDetails);
	el.title.addEventListener("click", openDetails);
	el.detailsBack.addEventListener("click", stepBack);
	document.addEventListener("keydown", (event) => {
		if (event.key === "Escape") stepBack();
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
			clearTimeout(jumpTimer);
			clearInterval(releaseTimer);
			clearInterval(runTimer);
			clearInterval(runningTimer);
		},
	};
}
