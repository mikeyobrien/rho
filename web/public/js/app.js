const TERMINAL_HEIGHT_KEY = "rho-terminal-drawer-height";
const TERMINAL_DEFAULT_HEIGHT = 320;
const TERMINAL_MIN_HEIGHT = 220;

function isMobileTerminalLayout() {
	return window.innerWidth <= 720;
}

function isMobileTerminalEnvironment() {
	const params = new URLSearchParams(window.location.search);
	return (
		params.get("mobile_shell") === "1" ||
		window.matchMedia?.("(pointer: coarse)")?.matches ||
		isMobileTerminalLayout()
	);
}

function clampTerminalHeight(height) {
	const footerHeight = document.querySelector(".footer")?.offsetHeight ?? 40;
	const navHeight = document.querySelector(".nav")?.offsetHeight ?? 48;
	const maxHeight = Math.max(
		TERMINAL_MIN_HEIGHT,
		window.innerHeight - navHeight - footerHeight,
	);
	return Math.max(TERMINAL_MIN_HEIGHT, Math.min(height, maxHeight));
}

function readTerminalHeight() {
	const raw = Number.parseInt(
		localStorage.getItem(TERMINAL_HEIGHT_KEY) || "",
		10,
	);
	if (!Number.isFinite(raw)) {
		return TERMINAL_DEFAULT_HEIGHT;
	}
	return clampTerminalHeight(raw);
}

document.addEventListener("alpine:init", () => {
	Alpine.data("rhoApp", () => ({
		view: "chat",
		theme: "dark",
		activeReviewCount: 0,
		activeTerminalCount: 0,
		terminalOpen: false,
		terminalExpanded: false,
		terminalResizing: false,
		terminalHeight: readTerminalHeight(),
		terminalModifierKeysEnabled: false,
		terminalCtrlSticky: false,
		terminalAltSticky: false,
		_onUiEvent: null,
		_onTerminalEvent: null,
		_onVisibilityChange: null,
		_onWindowResize: null,
		_onModifierKeysChanged: null,
		_onTerminalResizeMove: null,
		_onTerminalResizeUp: null,
		_terminalClient: null,
		_openTerminalOnInit: false,

		init() {
			const qsView = new URLSearchParams(window.location.search).get("view");
			if (qsView === "terminal") {
				this._openTerminalOnInit = true;
			} else if (["chat", "memory", "review", "config"].includes(qsView)) {
				this.view = qsView;
			}

			const savedTheme = localStorage.getItem("rho-theme");
			this.theme = savedTheme === "light" ? "light" : "dark";
			document.body.classList.toggle("theme-light", this.theme === "light");
			this.terminalModifierKeysEnabled =
				localStorage.getItem("rho-mobile-modifier-keys") === "1" ||
				isMobileTerminalEnvironment();

			this._pollUiCounts(true);

			this._onUiEvent = (event) => {
				const name = event?.detail?.name;
				if (name === "review_sessions_changed") {
					this._pollUiCounts(true);
				}
			};
			window.addEventListener("rho:ui-event", this._onUiEvent);

			this._onTerminalEvent = () => {
				this._pollUiCounts(true);
			};
			window.addEventListener(
				"rho:terminal-sessions-changed",
				this._onTerminalEvent,
			);

			this._onVisibilityChange = () => {
				if (!document.hidden) {
					this._pollUiCounts(true);
					if (this.terminalOpen) {
						this.syncTerminalLayout();
					}
				}
			};
			document.addEventListener("visibilitychange", this._onVisibilityChange);

			this._onWindowResize = () => {
				this.terminalHeight = clampTerminalHeight(this.terminalHeight);
				if (this.terminalOpen) {
					if (isMobileTerminalLayout()) {
						this.terminalExpanded = true;
					}
					this.syncTerminalLayout();
				}
			};
			window.addEventListener("resize", this._onWindowResize);
			this._onModifierKeysChanged = (event) => {
				this.terminalModifierKeysEnabled =
					!!event.detail?.enabled || isMobileTerminalEnvironment();
				if (!this.terminalModifierKeysEnabled) {
					this.clearTerminalStickyModifiers();
				}
			};
			window.addEventListener(
				"rho:modifier-keys-changed",
				this._onModifierKeysChanged,
			);

			queueMicrotask(() => {
				if (this._openTerminalOnInit) {
					this.openTerminalDrawer();
				}
			});
		},

		destroy() {
			if (this._onUiEvent) {
				window.removeEventListener("rho:ui-event", this._onUiEvent);
				this._onUiEvent = null;
			}
			if (this._onTerminalEvent) {
				window.removeEventListener(
					"rho:terminal-sessions-changed",
					this._onTerminalEvent,
				);
				this._onTerminalEvent = null;
			}
			if (this._onVisibilityChange) {
				document.removeEventListener(
					"visibilitychange",
					this._onVisibilityChange,
				);
				this._onVisibilityChange = null;
			}
			if (this._onWindowResize) {
				window.removeEventListener("resize", this._onWindowResize);
				this._onWindowResize = null;
			}
			if (this._onModifierKeysChanged) {
				window.removeEventListener(
					"rho:modifier-keys-changed",
					this._onModifierKeysChanged,
				);
				this._onModifierKeysChanged = null;
			}
			this.stopTerminalResize();
			this._terminalClient?.dispose?.();
			this._terminalClient = null;
		},

		toggleTheme() {
			this.theme = this.theme === "light" ? "dark" : "light";
			document.body.classList.toggle("theme-light", this.theme === "light");
			localStorage.setItem("rho-theme", this.theme);
		},

		async _pollUiCounts(force = false) {
			if (!force && document.hidden) return;

			try {
				const reviewRes = await fetch("/api/review/sessions");
				if (reviewRes.ok) {
					const sessions = await reviewRes.json();
					this.activeReviewCount = sessions.filter((s) => !s.done).length;
				}
			} catch {
				/* ignore */
			}

			try {
				const terminalRes = await fetch("/api/terminal/sessions");
				if (terminalRes.ok) {
					const sessions = await terminalRes.json();
					this.activeTerminalCount = Array.isArray(sessions)
						? sessions.length
						: 0;
				}
			} catch {
				/* ignore */
			}
		},

		setView(nextView) {
			if (!["chat", "memory", "review", "config"].includes(nextView)) {
				return;
			}
			this.view = nextView;

			const url = new URL(window.location.href);
			if (nextView === "chat") url.searchParams.delete("view");
			else url.searchParams.set("view", nextView);
			window.history.replaceState(
				{},
				"",
				`${url.pathname}${url.search}${url.hash}`,
			);

			window.dispatchEvent(
				new CustomEvent("rho:view-changed", {
					detail: { view: nextView },
				}),
			);

			this._pollUiCounts(true);
		},

		async ensureTerminalClient() {
			if (this._terminalClient) {
				return this._terminalClient;
			}
			const module = await import("/js/terminal-core.js?v=20260315v1");
			this._terminalClient = module.createTerminalClient({
				rootEl: this.$refs.terminalRoot,
				connectionStatusEl: this.$refs.terminalConnectionStatus,
				sessionStatusEl: this.$refs.terminalSessionStatus,
				detailStatusEl: this.$refs.terminalDetailStatus,
				overlayEl: this.$refs.terminalOverlay,
				overlayTitleEl: this.$refs.terminalOverlayTitle,
				overlayMessageEl: this.$refs.terminalOverlayMessage,
			});
			this._terminalClient.setInputTransform((data) =>
				this.transformTerminalInput(data),
			);
			return this._terminalClient;
		},

		async openTerminalDrawer(options = {}) {
			this.terminalOpen = true;
			if (options.expanded || isMobileTerminalLayout()) {
				this.terminalExpanded = true;
			}
			const client = await this.ensureTerminalClient();
			await client.connect();
			this.syncTerminalLayout();
		},

		closeTerminalDrawer() {
			this.terminalOpen = false;
			this.terminalExpanded = false;
			this.clearTerminalStickyModifiers();
			this.stopTerminalResize();
		},

		toggleTerminalDrawer() {
			if (this.terminalOpen) {
				this.closeTerminalDrawer();
				return;
			}
			this.openTerminalDrawer();
		},

		async toggleTerminalExpanded() {
			if (!this.terminalOpen) {
				await this.openTerminalDrawer({ expanded: true });
				return;
			}
			this.terminalExpanded = !this.terminalExpanded;
			this.syncTerminalLayout();
		},

		async reconnectTerminal() {
			const client = await this.ensureTerminalClient();
			this.terminalOpen = true;
			await client.reconnect();
			this.syncTerminalLayout();
		},

		async newTerminalSession() {
			const client = await this.ensureTerminalClient();
			this.terminalOpen = true;
			client.startFreshSession();
			this.syncTerminalLayout();
		},

		terminalModifierBarVisible() {
			return (
				this.terminalOpen &&
				(this.terminalModifierKeysEnabled || isMobileTerminalEnvironment())
			);
		},

		clearTerminalStickyModifiers() {
			this.terminalCtrlSticky = false;
			this.terminalAltSticky = false;
		},

		toggleTerminalCtrlSticky() {
			this.terminalCtrlSticky = !this.terminalCtrlSticky;
			if (this.terminalCtrlSticky) {
				this.terminalAltSticky = false;
			}
			this._terminalClient?.focus?.();
		},

		toggleTerminalAltSticky() {
			this.terminalAltSticky = !this.terminalAltSticky;
			if (this.terminalAltSticky) {
				this.terminalCtrlSticky = false;
			}
			this._terminalClient?.focus?.();
		},

		async sendTerminalSequence(data) {
			const client = await this.ensureTerminalClient();
			this.terminalOpen = true;
			await client.connect();
			if (!client.sendInput(data)) {
				return;
			}
			client.focus?.();
			this.clearTerminalStickyModifiers();
		},

		terminalSequenceForKey(key) {
			const baseMap = {
				Escape: "\u001b",
				Tab: "\t",
				ArrowUp: "\u001b[A",
				ArrowDown: "\u001b[B",
				ArrowRight: "\u001b[C",
				ArrowLeft: "\u001b[D",
				Home: "\u001b[H",
				End: "\u001b[F",
				PageUp: "\u001b[5~",
				PageDown: "\u001b[6~",
			};
			return baseMap[key] || "";
		},

		transformTerminalInput(data) {
			if (!data) {
				return data;
			}
			if (this.terminalCtrlSticky) {
				const char = data.length === 1 ? data.toLowerCase() : "";
				if (char >= "a" && char <= "z") {
					this.clearTerminalStickyModifiers();
					return String.fromCharCode(char.charCodeAt(0) - 96);
				}
			}
			if (this.terminalAltSticky && data.length === 1) {
				this.clearTerminalStickyModifiers();
				return `\u001b${data}`;
			}
			return data;
		},

		sendTerminalModifierKey(key) {
			const data = this.terminalSequenceForKey(key);
			if (data) {
				this.sendTerminalSequence(data);
			}
		},

		terminalDrawerStyle() {
			if (!this.terminalOpen) {
				return "";
			}
			const height = this.terminalExpanded
				? clampTerminalHeight(window.innerHeight)
				: clampTerminalHeight(this.terminalHeight);
			return `height:${height}px`;
		},

		syncTerminalLayout() {
			if (!this._terminalClient || !this.terminalOpen) {
				return;
			}
			requestAnimationFrame(() => {
				requestAnimationFrame(() => {
					this._terminalClient?.fit?.();
					this._terminalClient?.focus?.();
				});
			});
		},

		startTerminalResize(event) {
			if (!this.terminalOpen || this.terminalExpanded || event.button !== 0) {
				return;
			}
			event.preventDefault();
			this.terminalResizing = true;
			this._onTerminalResizeMove = (moveEvent) => {
				const footerTop =
					document.querySelector(".footer")?.getBoundingClientRect().top ??
					window.innerHeight;
				this.terminalHeight = clampTerminalHeight(
					footerTop - moveEvent.clientY,
				);
			};
			this._onTerminalResizeUp = () => {
				this.terminalResizing = false;
				localStorage.setItem(
					TERMINAL_HEIGHT_KEY,
					String(clampTerminalHeight(this.terminalHeight)),
				);
				this.stopTerminalResize();
				this.syncTerminalLayout();
			};
			window.addEventListener("pointermove", this._onTerminalResizeMove);
			window.addEventListener("pointerup", this._onTerminalResizeUp, {
				once: true,
			});
		},

		stopTerminalResize() {
			if (this._onTerminalResizeMove) {
				window.removeEventListener("pointermove", this._onTerminalResizeMove);
				this._onTerminalResizeMove = null;
			}
			if (this._onTerminalResizeUp) {
				window.removeEventListener("pointerup", this._onTerminalResizeUp);
				this._onTerminalResizeUp = null;
			}
			this.terminalResizing = false;
		},
	}));
});
