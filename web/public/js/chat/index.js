import { rhoChatDialogAndFocusMethods } from "./chat-dialog-and-focus.js";
import { rhoChatGitContextMethods } from "./chat-git-context-picker.js";
import { rhoChatInputMethods } from "./chat-input-and-rpc-send.js";
import { rhoChatModelAndExtensionMethods } from "./chat-model-and-extension-ui.js";
import { rhoChatReactiveProps } from "./chat-reactive-props.js";
import { rhoChatRpcEventMethods } from "./chat-rpc-event-routing.js";
import { rhoChatSessionActionMethods } from "./chat-session-actions.js";
import { rhoChatSessionUiMethods } from "./chat-session-ui.js";
import { rhoChatSlashAndStatsMethods } from "./chat-slash-and-stats.js";
import { rhoChatStreamingMethods } from "./chat-streaming-parts.js";
import { rhoChatWsRpcMethods } from "./chat-ws-rpc.js";
import { THINKING_LEVELS_BASE } from "./rendering-and-usage.js";
import { rhoChatSessionRestoreMethods } from "./session-restore-persistence.js";
import {
	createDefaultSessionStats,
	ensureSessionStateById,
	getFocusedSessionStateById,
} from "./session-ui-state.js";
export function registerRhoChat() {
	document.addEventListener("alpine:init", () => {
		Alpine.data("rhoChat", () => {
			const component = {
				sessions: [],
				focusedSessionId: "",
				sessionStateById: new Map(),
				globalError: "",
				isLoadingSessions: false,
				isForking: false,
				poller: null,
				ws: null,
				markdownRenderQueue: new Map(),
				markdownTimeout: null,
				showSessionsPanel: false,
				activeGitProject: "",
				activeGitPath: "",
				activeGitCwd: "",
				showGitProjectPicker: false,
				gitProjects: [],
				gitProjectsLoading: false,
				gitProjectsError: "",
				selectedGitProjectId: "",
				ensureSessionState(sessionId, meta = {}) {
					if (!(this.sessionStateById instanceof Map)) {
						this.sessionStateById = new Map();
					}
					return ensureSessionStateById(
						this.sessionStateById,
						sessionId,
						meta,
						{
							makeReactive: (state) => this.makeSessionStateReactive(state),
						},
					);
				},
				getFocusedSessionState() {
					return getFocusedSessionStateById(
						this.sessionStateById,
						this.focusedSessionId,
					);
				},

				makeSessionStateReactive(state) {
					const reactive = globalThis.Alpine?.reactive;
					if (typeof reactive === "function") {
						return reactive(state);
					}
					return state;
				},

				readSessionField(field, fallback) {
					const state = this.getFocusedSessionState();
					if (!state || state[field] === undefined) {
						return typeof fallback === "function" ? fallback() : fallback;
					}
					return state[field];
				},

				writeSessionField(field, value) {
					const state = this.getFocusedSessionState();
					if (!state) {
						return;
					}
					state[field] = value;
				},

				isDraggingOver: false,
				dragLeaveTimeout: null,
				thinkingLevels: [...THINKING_LEVELS_BASE],
				extensionDialog: null,
				extensionWidget: null,
				toasts: [],
				toastIdCounter: 0,
				wsReconnectAttempts: 0,
				wsReconnectTimer: null,
				wsMaxReconnectDelay: 30000,
				wsBaseReconnectDelay: 1000,
				wsPingTimer: null,
				isWsConnected: false,
				showReconnectBanner: false,
				reconnectBannerMessage: "",
				streamDisconnectedDuringResponse: false,
				awaitingStreamReconnectState: false,
				rpcCommandCounter: 0,
				theme: "dark",
				lastActivityTime: Date.now(),
				isIdle: false,
				idleCheckInterval: null,
				isPageVisible: true,
				modifierKeysEnabled:
					localStorage.getItem("rho-mobile-modifier-keys") === "1",
				ctrlSticky: false,
				async init() {
					this.theme = localStorage.getItem("rho-theme") || "dark";
					if (this.theme === "light") {
						document.body.classList.add("theme-light");
					}
					const markdown = globalThis.marked;
					if (markdown && typeof markdown.setOptions === "function") {
						markdown.setOptions({ gfm: true, breaks: true });
					}
					this.connectWebSocket();
					const hashId = window.location.hash.replace("#", "").trim();
					const restored = this.preparePersistedRestoreSnapshot(hashId);
					if (hashId) {
						this.activeSessionId = hashId;
					}
					this.setupIdleDetection();
					this.setupVisibilityDetection();
					this.bindGitFooterPickerTrigger();
					this.refreshGitProject();
					await this.loadSessions();
					await this.restorePersistedSessionRuntime(restored);
					this.startPolling();
					this.setupKeyboardShortcuts();
					this.setupPullToRefresh();
					this.setupScrollIntentDetection();
					window.addEventListener("hashchange", () => {
						const id = window.location.hash.replace("#", "").trim();
						if (!id) {
							this.clearSelectedSession();
							return;
						}
						if (id !== this.activeSessionId) {
							this.selectSession(id, { updateHash: false });
						}
					});
					window.addEventListener("rho:modifier-keys-changed", (e) => {
						this.modifierKeysEnabled = !!e.detail?.enabled;
						if (!this.modifierKeysEnabled) this.ctrlSticky = false;
					});
				},
				...rhoChatInputMethods,
				...rhoChatWsRpcMethods,
				...rhoChatRpcEventMethods,
				...rhoChatStreamingMethods,
				...rhoChatSessionUiMethods,
				...rhoChatSessionActionMethods,
				...rhoChatSlashAndStatsMethods,
				...rhoChatModelAndExtensionMethods,
				...rhoChatGitContextMethods,
				...rhoChatSessionRestoreMethods,
				...rhoChatDialogAndFocusMethods,
			};

			Object.defineProperties(
				component,
				Object.getOwnPropertyDescriptors(rhoChatReactiveProps),
			);
			return component;
		});
	});
}
