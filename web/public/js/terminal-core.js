import {
	buildTerminalWsUrl,
	notifyTerminalSessionsChanged,
	readStoredSessionId,
	storeSessionId,
} from "/js/terminal-session-store.js";
import { bindTerminalTouchScroll } from "/js/terminal-touch.js";
import { FitAddon, Terminal, init } from "/vendor/ghostty-web.js";
class TerminalClient {
	constructor(elements) {
		this.rootEl = elements.rootEl;
		this.connectionStatusEl = elements.connectionStatusEl;
		this.sessionStatusEl = elements.sessionStatusEl;
		this.detailStatusEl = elements.detailStatusEl;
		this.overlayEl = elements.overlayEl;
		this.overlayTitleEl = elements.overlayTitleEl;
		this.overlayMessageEl = elements.overlayMessageEl;
		this.term = null;
		this.fitAddon = null;
		this.ws = null;
		this.sessionId = "";
		this.initPromise = null;
		this.lastResize = { cols: 120, rows: 32 };
		this.pendingFreshSession = false;
		this.lastKeyboardInput = { at: 0, data: "" };
		this.inputTransform = null;
		this._textEncoder = new TextEncoder();
		this._textDecoder = new TextDecoder();
	}
	setConnectionStatus(value) {
		if (this.connectionStatusEl) {
			this.connectionStatusEl.textContent = value;
		}
	}
	setSessionStatus(value) {
		if (this.sessionStatusEl) {
			this.sessionStatusEl.textContent = value;
		}
	}
	setDetailStatus(value) {
		if (this.detailStatusEl) {
			this.detailStatusEl.textContent = value;
		}
	}
	showOverlay(title, message) {
		if (this.overlayTitleEl) {
			this.overlayTitleEl.textContent = title;
		}
		if (this.overlayMessageEl) {
			this.overlayMessageEl.textContent = message;
		}
		this.overlayEl?.classList.remove("is-hidden");
	}
	hideOverlay() {
		this.overlayEl?.classList.add("is-hidden");
	}
	focus() {
		if (this.term?.textarea && typeof this.term.textarea.focus === "function") {
			this.term.textarea.focus();
			return;
		}
		this.term?.element?.focus?.();
		this.term?.focus?.();
	}
	fit() {
		this.fitAddon?.fit?.();
		this.requestResize();
	}
	setInputTransform(transform) {
		this.inputTransform = typeof transform === "function" ? transform : null;
	}
	sendInput(data) {
		if (!this.sessionId || !data) {
			return false;
		}
		const nextData = this.inputTransform ? this.inputTransform(data) : data;
		if (!nextData) {
			return false;
		}
		// Send terminal input as raw binary frame — avoids JSON overhead.
		if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
			return false;
		}
		this.ws.send(this._textEncoder.encode(nextData));
		return true;
	}
	reconnect() {
		if (this.ws) {
			try {
				this.ws.close();
			} catch {
				// Ignore close errors.
			}
			this.ws = null;
		}
		return this.connect();
	}
	startFreshSession() {
		this.pendingFreshSession = true;
		storeSessionId("");
		if (!this.sessionId) {
			this.pendingFreshSession = false;
			this.bootstrapSession();
			return;
		}
		this.setSessionStatus("Resetting…");
		this.setDetailStatus("Closing the current shell and starting a new one…");
		this.send({ type: "close", sessionId: this.sessionId });
	}
	dispose() {
		if (this.ws) {
			try {
				this.ws.close();
			} catch {
				// Ignore close errors.
			}
			this.ws = null;
		}
		this.term?.dispose?.();
		this.term = null;
		this.fitAddon = null;
	}
	send(payload) {
		if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
			return false;
		}
		this.ws.send(JSON.stringify(payload));
		return true;
	}
	currentFitSize() {
		const proposed = this.fitAddon?.proposeDimensions?.();
		if (proposed?.cols && proposed?.rows) {
			this.lastResize = proposed;
			return proposed;
		}
		return this.lastResize;
	}
	requestResize() {
		if (!this.sessionId) {
			return;
		}
		const size = this.currentFitSize();
		this.send({
			type: "resize",
			sessionId: this.sessionId,
			cols: size.cols,
			rows: size.rows,
		});
	}
	rememberKeyboardInput(data) {
		this.lastKeyboardInput = { at: performance.now(), data };
	}
	recentlyHandledKeyboardInput(data) {
		const age = performance.now() - this.lastKeyboardInput.at;
		if (age > 120) {
			return false;
		}
		if (!data) {
			return true;
		}
		return this.lastKeyboardInput.data === data;
	}
	mapBeforeInputToTerminalData(event) {
		switch (event.inputType) {
			case "insertText":
			case "insertCompositionText":
			case "insertReplacementText":
				return event.data || "";
			case "insertLineBreak":
			case "insertParagraph":
				return "\r";
			case "deleteContentBackward":
				return "\x7f";
			case "deleteWordBackward":
				return "\x17";
			default:
				return "";
		}
	}
	clearTerminalTextarea() {
		if (this.term?.textarea) {
			this.term.textarea.value = "";
		}
	}
	attachTextInputFallback() {
		const textarea = this.term?.textarea;
		if (!textarea || textarea.dataset.rhoFallbackBound === "1") {
			return;
		}
		textarea.dataset.rhoFallbackBound = "1";
		const markKeydown = (event) => {
			// Skip IME / virtual-keyboard events (keyCode 229).  Ghostty-web
			// bails on these, so marking them as "handled" would prevent the
			// beforeinput fallback from sending the actual input.
			if (event.keyCode === 229 || event.isComposing) {
				return;
			}
			const data = this.mapBeforeInputToTerminalData({
				inputType:
					event.key === "Enter"
						? "insertLineBreak"
						: event.key === "Backspace"
							? "deleteContentBackward"
							: "insertText",
				data: event.key.length === 1 ? event.key : "",
			});
			if (data || event.key === "Tab") {
				this.rememberKeyboardInput(data || "\t");
			}
		};
		if (this.rootEl.dataset.rhoFallbackBound !== "1") {
			this.rootEl.dataset.rhoFallbackBound = "1";
			this.rootEl.addEventListener("keydown", markKeydown, true);
		}
		textarea.addEventListener("keydown", markKeydown, true);
		textarea.addEventListener("beforeinput", (event) => {
			const data = this.mapBeforeInputToTerminalData(event);
			if (!data || this.recentlyHandledKeyboardInput(data) || !this.sessionId) {
				return;
			}
			event.preventDefault();
			this.clearTerminalTextarea();
			this.rememberKeyboardInput(data);
			this.sendInput(data);
		});
		textarea.addEventListener("input", () => {
			const value = textarea.value || "";
			if (!value) {
				return;
			}
			this.clearTerminalTextarea();
			if (this.recentlyHandledKeyboardInput(value) || !this.sessionId) {
				return;
			}
			this.rememberKeyboardInput(value);
			this.sendInput(value);
		});
		textarea.addEventListener("blur", () => {
			this.clearTerminalTextarea();
		});
	}
	createTerminal() {
		this.term?.dispose?.();
		this.term = new Terminal({
			cursorBlink: true,
			cursorStyle: "block",
			fontFamily: '"Iosevka Web", "Iosevka Nerd Font", "Iosevka", monospace',
			fontSize: 14,
			lineHeight: 1.25,
			convertEol: false,
			theme: {
				background: "#0a0d10",
				foreground: "#d8e3ea",
				cursor: "#7cc4ff",
				selectionBackground: "#28465f",
				black: "#1a242c",
				red: "#ff8f8f",
				green: "#87d7a1",
				yellow: "#e8cf86",
				blue: "#7cc4ff",
				magenta: "#d7a0ff",
				cyan: "#77d8d8",
				white: "#d8e3ea",
				brightBlack: "#4c6373",
				brightRed: "#ffb0b0",
				brightGreen: "#a3e5b7",
				brightYellow: "#f2dfa5",
				brightBlue: "#9ad2ff",
				brightMagenta: "#e2b8ff",
				brightCyan: "#95eeee",
				brightWhite: "#f5fbff",
			},
		});
		this.fitAddon = new FitAddon();
		this.term.loadAddon(this.fitAddon);
		this.term.open(this.rootEl);
		// ghostty-web sets contenteditable="true" on the root element to
		// enable virtual keyboards.  On mobile this backfires: the browser
		// binds its IME and editing logic to the div, swallowing Backspace
		// and other keys.  The hidden textarea already handles all input,
		// so strip the attribute immediately after open().
		this.rootEl.removeAttribute("contenteditable");
		this.attachTextInputFallback();
		bindTerminalTouchScroll({
			surfaceEl: this.term.canvas,
			getTerm: () => this.term,
			getRows: () => this.lastResize?.rows || this.term?.rows || 1,
			focus: () => this.focus(),
		});
		this.fitAddon.fit();
		this.fitAddon.observeResize();
		this.lastResize = this.currentFitSize();
		this.term.onData((data) => {
			this.sendInput(data);
		});
		this.term.onResize(({ cols, rows }) => {
			this.lastResize = { cols, rows };
			this.requestResize();
		});
		if (this.rootEl.dataset.rhoFocusBound !== "1") {
			this.rootEl.dataset.rhoFocusBound = "1";
			this.rootEl.addEventListener("pointerdown", (e) => {
				// Prevent the contenteditable root from capturing focus/IME on
				// mobile — redirect to the hidden textarea synchronously so the
				// virtual keyboard binds to the right element.
				if (e.target !== this.term?.textarea) {
					e.preventDefault();
				}
				this.focus();
			});
			this.rootEl.addEventListener("click", () => {
				this.focus();
			});
		}
		this.focus();
	}
	async ensureGhostty() {
		if (!this.initPromise) {
			this.initPromise = init();
		}
		await this.initPromise;
	}
	applySession(session, options = {}) {
		this.sessionId = session?.id || "";
		storeSessionId(this.sessionId);
		this.term.reset();
		if (typeof options.replay === "string" && options.replay) {
			this.term.write(options.replay);
		}
		this.setSessionStatus(
			this.sessionId ? `Live (${this.sessionId.slice(0, 8)})` : "Live",
		);
		this.setDetailStatus(
			session?.pid
				? `pid ${session.pid} · ${session.shell} · ${session.cwd}`
				: `Shell ready · ${session?.cwd || ""}`,
		);
		this.setConnectionStatus("Connected");
		this.hideOverlay();
		this.requestResize();
		this.focus();
	}

	bootstrapSession() {
		const storedSessionId = readStoredSessionId();
		if (storedSessionId) {
			this.setSessionStatus(`Reattaching (${storedSessionId.slice(0, 8)})`);
			this.setDetailStatus(
				"Trying to reconnect to the existing shell session…",
			);
			this.send({ type: "attach", sessionId: storedSessionId });
			return;
		}
		this.setSessionStatus("Starting…");
		this.setDetailStatus("Starting a fresh shell session…");
		const size = this.currentFitSize();
		this.send({ type: "create", cols: size.cols, rows: size.rows });
	}

	handleMessage(event) {
		// Binary frames are raw PTY output — write directly as Uint8Array
		// to skip ghostty-web's internal TextEncoder allocation.
		if (event.data instanceof ArrayBuffer) {
			this.term?.write(new Uint8Array(event.data));
			return;
		}

		let payload = null;
		try {
			payload = JSON.parse(event.data);
		} catch {
			return;
		}
		if (payload.type === "terminal_ready") {
			this.bootstrapSession();
			return;
		}
		if (payload.type === "terminal_session_created") {
			this.pendingFreshSession = false;
			this.applySession(payload.session);
			notifyTerminalSessionsChanged();
			return;
		}
		if (payload.type === "terminal_session_attached") {
			this.pendingFreshSession = false;
			this.applySession(payload.session, { replay: payload.replay });
			return;
		}
		if (payload.type === "terminal_session_missing") {
			storeSessionId("");
			this.setDetailStatus(
				"Stored terminal session expired. Starting a fresh shell…",
			);
			const size = this.currentFitSize();
			this.send({ type: "create", cols: size.cols, rows: size.rows });
			return;
		}
		if (payload.type === "terminal_exit") {
			this.sessionId = "";
			storeSessionId("");
			notifyTerminalSessionsChanged();
			this.setSessionStatus("Exited");
			this.setDetailStatus(
				`Shell exited${typeof payload.exitCode === "number" ? ` with code ${payload.exitCode}` : ""}`,
			);
			if (this.pendingFreshSession) {
				this.pendingFreshSession = false;
				const size = this.currentFitSize();
				this.send({ type: "create", cols: size.cols, rows: size.rows });
				return;
			}
			this.showOverlay(
				"Session ended",
				"The shell exited. Reconnect to start a fresh terminal session.",
			);
			return;
		}
		if (payload.type === "terminal_error") {
			this.pendingFreshSession = false;
			this.setDetailStatus(payload.message || "Terminal error");
			this.showOverlay(
				"Terminal error",
				payload.message || "The terminal backend returned an error.",
			);
		}
	}

	async connect() {
		if (
			this.ws &&
			(this.ws.readyState === WebSocket.OPEN ||
				this.ws.readyState === WebSocket.CONNECTING)
		) {
			return;
		}
		this.setConnectionStatus("Connecting…");
		this.setSessionStatus(readStoredSessionId() ? "Reattaching…" : "Starting…");
		this.setDetailStatus("Bootstrapping ghostty-web and terminal transport…");
		this.showOverlay(
			"Connecting terminal",
			"Connecting to the terminal backend…",
		);
		await this.ensureGhostty();
		if (!this.term) {
			this.createTerminal();
		}
		const socket = new WebSocket(buildTerminalWsUrl());
		socket.binaryType = "arraybuffer";
		this.ws = socket;
		socket.addEventListener("open", () => {
			if (this.ws !== socket) {
				return;
			}
			this.setConnectionStatus("Handshake…");
			this.setDetailStatus(
				"WebSocket connected. Waiting for terminal backend…",
			);
		});
		socket.addEventListener("message", (messageEvent) => {
			if (this.ws !== socket) {
				return;
			}
			this.handleMessage(messageEvent);
		});
		socket.addEventListener("close", () => {
			if (this.ws !== socket) {
				return;
			}
			this.ws = null;
			this.setConnectionStatus("Disconnected");
			this.setSessionStatus(readStoredSessionId() ? "Paused" : "Offline");
			this.setDetailStatus(
				readStoredSessionId()
					? "Connection closed. Reconnect to reattach to the preserved shell session."
					: "Connection closed. Reconnect to start a new shell session.",
			);
			this.showOverlay(
				"Terminal offline",
				"The terminal connection is closed.",
			);
		});
		socket.addEventListener("error", () => {
			if (this.ws !== socket) {
				return;
			}
			this.setConnectionStatus("Error");
			this.setDetailStatus("Terminal websocket failed.");
			this.showOverlay(
				"Connection failed",
				"The terminal websocket could not be established.",
			);
		});
	}
}
export function createTerminalClient(elements) {
	return new TerminalClient(elements);
}
