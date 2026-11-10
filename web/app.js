// The rho page. The daemon's event stream is the state: this page keeps no second copy beyond
// older entries it has paged in, the draft, and messages it could not send yet.
import { renderMarkdown } from "./markdown.js";

const IDLE_MS = 30_000; // the daemon sends a keepalive every 15 s; this long with nothing is a dead path
const THINKING = ["low", "medium", "high", "xhigh", "max"];

/**
 * Start the page. `env` is what it touches of the browser: `document`, `storage` (localStorage),
 * `location`, `history`, `fetch`, and optionally `touch` and `visible()`. Returns `stop()`.
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
	let outbox = store.get("outbox", []); // [{ requestId, text }] not yet accepted by the daemon
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
				store.set("outbox", outbox);
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
					await api("submit", { text: item.text, requestId: item.requestId, whenBusy: item.mode ?? "steer" }, item.c ?? "");
				} catch (error) {
					if (error.status === undefined) return; // not reached: it stays "Not sent yet" and goes again later
					// The daemon refused it: give the words back instead of losing them.
					if (el.input.value.trim() === "") setDraft(item.text);
					flash(error.message);
				}
				outbox = outbox.slice(1);
				store.set("outbox", outbox);
				render();
			}
		} finally {
			sending = false;
		}
	}

	// A message sent while rho works joins the work in hand at its next step ("steer"); the
	// person can make it wait for the answer instead ("followUp"). Idle, both start a run.
	function submit(text, mode = "steer") {
		outbox = [...outbox, { requestId: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`, text, mode, c: conversation }];
		store.set("outbox", outbox);
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

	function nodeFor(entry, calls) {
		const existing = rendered.get(entry.id);
		if (existing) return existing;
		let node;
		if (entry.role === "divider") node = make("div", { className: "divider", textContent: entry.text });
		else if (entry.role === "user") node = make("div", { className: "msg user", textContent: entry.text });
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
		const key = entries.map((entry) => entry.id).join(",");
		const calls = new Map(); // call id -> the call, for its card
		for (const entry of entries) for (const call of entry.calls ?? []) calls.set(call.id, call);
		if (key !== drawn) {
			el.entries.replaceChildren(...entries.map((entry) => nodeFor(entry, calls)));
			drawn = key;
		}
		el.earlier.hidden = !moreEarlier;

		const live = [];
		for (const item of outbox.filter((kept) => (kept.c ?? "") === conversation)) {
			live.push(make("div", { className: "msg user unsent", textContent: item.text }));
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
			card.append(note(`Needs your yes: ${ask.what}`, "note approval-what"), make("pre", { textContent: ask.command }), buttons);
			live.push(card);
		}
		if (state?.running) {
			for (const tool of state.tools) if (tool.status !== "done") live.push(Object.assign(toolCard(tool.name, calls.get(tool.id), "running", tool.output.slice(-2000), false), { open: tool.output !== "" }));
			if (state.partial) live.push(make("div", { className: "msg assistant streaming", textContent: state.partial }));
			else if (state.retry) live.push(note(`Trying again, attempt ${state.retry.attempt}`, "note working"));
			else if (!state.tools.some((tool) => tool.status !== "done")) live.push(note("Working", "note working"));
		} else if (state?.failure) {
			const text = state.failure.detail ? `${state.failure.text} ${state.failure.detail}` : state.failure.text;
			live.push(note(text, state.failure.reason === "aborted" ? "note" : "note failure"));
		}
		el.live.replaceChildren(...live);
		el.empty.hidden = entries.length > 0 || live.length > 0 || state === undefined;

		el.queue.replaceChildren(
			...(state?.queued ?? []).map((item) => {
				const row = make("li", {});
				const steer = item.mode === "steer";
				row.append(make("span", { className: "chip", textContent: steer ? "Steer · next step" : "Queued · after the answer" }));
				row.append(make("span", { className: "queued-text", textContent: item.text }));
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
				remove.setAttribute("aria-label", `Remove waiting message: ${item.text.slice(0, 60)}`);
				remove.addEventListener("click", async () => {
					try {
						const { result } = await api("unqueue", { id: item.id });
						if (result === "aborted" && el.input.value.trim() === "") setDraft(item.text); // give the words back
					} catch (error) {
						flash(error.message);
					}
				});
				row.append(remove, flip);
				return row;
			}),
		);

		if (!el.menu.hidden) syncMenu();
		renderStatus();
		renderSend();
		if (stick) el.thread.scrollTop = el.thread.scrollHeight;
		el.latest.hidden = stick;
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
		el.status.textContent = flashText || text;
		el.status.classList.toggle("warn", flashText !== "" || connection === "offline" || connection === "unpaired");
		el.notice.hidden = connection !== "offline" && connection !== "unpaired";
		el.noticeText.textContent = connection === "unpaired"
			? "This browser is not paired. On the machine rho runs on, run: rho open"
			: outbox.length > 0 ? "Can't reach rho. Your message is kept and sends when it is back." : "Can't reach rho.";
		if (el.newChat) el.newChat.textContent = "Clear context";
	}

	function renderSend() {
		const hasWords = el.input.value.trim() !== "";
		const stop = Boolean(state?.running) && !hasWords;
		el.send.textContent = stop ? "Stop" : "Send";
		el.send.setAttribute("aria-label", stop ? "Stop" : state?.running ? "Send to the work in hand" : "Send");
		el.send.classList.toggle("stop", stop);
		el.send.disabled = !stop && !hasWords;
	}

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
		if (text === "") {
			if (!state?.running) return;
			try {
				await api("stop", {});
			} catch (error) {
				flash(error.message);
			}
			return;
		}
		setDraft("");
		submit(text, nextMode);
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
		void stream();
	});
	return {
		ready,
		stop() {
			stopped = true;
			streamAbort?.abort();
			clearTimeout(flashTimer);
		},
	};
}
