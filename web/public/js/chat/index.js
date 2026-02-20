import { rhoChatDialogAndFocusMethods } from "./chat-dialog-and-focus.js";
import { rhoChatGitContextMethods } from "./chat-git-context-picker.js";
import { rhoChatInputRpcMethods } from "./chat-input-and-rpc-send.js";
import { rhoChatModelAndExtensionMethods } from "./chat-model-and-extension-ui.js";
import { rhoChatRpcEventMethods } from "./chat-rpc-event-routing.js";
import { rhoChatSessionActionMethods } from "./chat-session-actions.js";
import { rhoChatSessionUiMethods } from "./chat-session-ui.js";
import { rhoChatSlashAndStatsMethods } from "./chat-slash-and-stats.js";
import { rhoChatStreamingMethods } from "./chat-streaming-parts.js";
import { THINKING_LEVELS_BASE } from "./rendering-and-usage.js";
import { rhoChatSessionRestoreMethods } from "./session-restore-persistence.js";
import {
	createDefaultSessionStats,
	ensureSessionStateById,
	getFocusedSessionStateById,
} from "./session-ui-state.js";

export function registerRhoChat() {
	document.addEventListener("alpine:init", () => {
		Alpine.data("rhoChat", () => ({
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

			toggleTheme() {
				this.theme = this.theme === "light" ? "dark" : "light";
				document.body.classList.toggle("theme-light", this.theme === "light");
				localStorage.setItem("rho-theme", this.theme);
			},

			ensureSessionState(sessionId, meta = {}) {
				if (!(this.sessionStateById instanceof Map)) {
					this.sessionStateById = new Map();
				}
				return ensureSessionStateById(this.sessionStateById, sessionId, meta, {
					makeReactive: (state) => this.makeSessionStateReactive(state),
				});
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

			get activeSessionId() {
				return this.focusedSessionId;
			},
			set activeSessionId(value) {
				const next = typeof value === "string" ? value.trim() : "";
				this.focusedSessionId = next;
				if (next) this.ensureSessionState(next);
				this.persistSessionRestoreSnapshot();
			},

			get activeSession() {
				return this.readSessionField("activeSession", null);
			},
			set activeSession(value) {
				this.writeSessionField("activeSession", value);
			},

			get renderedMessages() {
				return this.readSessionField("renderedMessages", () => []);
			},
			set renderedMessages(value) {
				this.writeSessionField(
					"renderedMessages",
					Array.isArray(value) ? value : [],
				);
			},

			get isLoadingSession() {
				return this.readSessionField("isLoadingSession", false);
			},
			set isLoadingSession(value) {
				this.writeSessionField("isLoadingSession", Boolean(value));
			},

			get isSendingPrompt() {
				return this.readSessionField("isSendingPrompt", false);
			},
			set isSendingPrompt(value) {
				this.writeSessionField("isSendingPrompt", Boolean(value));
			},

			get error() {
				const state = this.getFocusedSessionState();
				if (state) {
					return typeof state.error === "string" ? state.error : "";
				}
				return this.globalError;
			},
			set error(value) {
				const next = typeof value === "string" ? value : "";
				const focusedState = this.getFocusedSessionState();
				if (focusedState) {
					focusedState.error = next;
					if (next) {
						this.globalError = "";
					}
					return;
				}
				this.globalError = next;
			},

			get activeRpcSessionId() {
				return this.readSessionField("rpcSessionId", "");
			},
			set activeRpcSessionId(value) {
				this.writeSessionField(
					"rpcSessionId",
					typeof value === "string" ? value : "",
				);
			},

			get activeRpcSessionFile() {
				return this.readSessionField("sessionFile", "");
			},
			set activeRpcSessionFile(value) {
				this.writeSessionField(
					"sessionFile",
					typeof value === "string" ? value : "",
				);
			},

			get promptText() {
				return this.readSessionField("promptText", "");
			},
			set promptText(value) {
				this.writeSessionField(
					"promptText",
					typeof value === "string" ? value : "",
				);
				this.schedulePersistSessionRestoreSnapshot();
			},

			get pendingSlashClassification() {
				return this.readSessionField("pendingSlashClassification", null);
			},
			set pendingSlashClassification(value) {
				this.writeSessionField("pendingSlashClassification", value ?? null);
			},

			get slashCommands() {
				return this.readSessionField("slashCommands", () => []);
			},
			set slashCommands(value) {
				this.writeSessionField(
					"slashCommands",
					Array.isArray(value) ? value : [],
				);
			},

			get slashCommandIndex() {
				return this.readSessionField("slashCommandIndex", () => new Map());
			},
			set slashCommandIndex(value) {
				this.writeSessionField(
					"slashCommandIndex",
					value instanceof Map ? value : new Map(),
				);
			},

			get slashCommandsLoading() {
				return this.readSessionField("slashCommandsLoading", false);
			},
			set slashCommandsLoading(value) {
				this.writeSessionField("slashCommandsLoading", Boolean(value));
			},

			get slashCommandsLoaded() {
				return this.readSessionField("slashCommandsLoaded", false);
			},
			set slashCommandsLoaded(value) {
				this.writeSessionField("slashCommandsLoaded", Boolean(value));
			},

			get slashAcVisible() {
				return this.readSessionField("slashAcVisible", false);
			},
			set slashAcVisible(value) {
				this.writeSessionField("slashAcVisible", Boolean(value));
			},

			get slashAcItems() {
				return this.readSessionField("slashAcItems", () => []);
			},
			set slashAcItems(value) {
				this.writeSessionField(
					"slashAcItems",
					Array.isArray(value) ? value : [],
				);
			},

			get slashAcIndex() {
				return this.readSessionField("slashAcIndex", 0);
			},
			set slashAcIndex(value) {
				const next = Number(value);
				this.writeSessionField(
					"slashAcIndex",
					Number.isFinite(next) ? next : 0,
				);
			},

			get streamMessageId() {
				return this.readSessionField("streamMessageId", "");
			},
			set streamMessageId(value) {
				this.writeSessionField(
					"streamMessageId",
					typeof value === "string" ? value : "",
				);
			},

			get hasEarlierMessages() {
				return this.readSessionField("hasEarlierMessages", false);
			},
			set hasEarlierMessages(value) {
				this.writeSessionField("hasEarlierMessages", Boolean(value));
			},

			get allNormalizedMessages() {
				return this.readSessionField("allNormalizedMessages", () => []);
			},
			set allNormalizedMessages(value) {
				this.writeSessionField(
					"allNormalizedMessages",
					Array.isArray(value) ? value : [],
				);
			},

			get toolCallPartById() {
				return this.readSessionField("toolCallPartById", () => new Map());
			},
			set toolCallPartById(value) {
				this.writeSessionField(
					"toolCallPartById",
					value instanceof Map ? value : new Map(),
				);
			},

			get promptQueue() {
				return this.readSessionField("promptQueue", () => []);
			},
			set promptQueue(value) {
				this.writeSessionField(
					"promptQueue",
					Array.isArray(value) ? value : [],
				);
			},

			get showQueue() {
				return this.readSessionField("showQueue", false);
			},
			set showQueue(value) {
				this.writeSessionField("showQueue", Boolean(value));
			},

			get pendingImages() {
				return this.readSessionField("pendingImages", () => []);
			},
			set pendingImages(value) {
				this.writeSessionField(
					"pendingImages",
					Array.isArray(value) ? value : [],
				);
			},

			get availableModels() {
				return this.readSessionField("availableModels", () => []);
			},
			set availableModels(value) {
				this.writeSessionField(
					"availableModels",
					Array.isArray(value) ? value : [],
				);
			},

			get currentModel() {
				return this.readSessionField("currentModel", null);
			},
			set currentModel(value) {
				this.writeSessionField("currentModel", value ?? null);
			},

			get currentThinkingLevel() {
				return this.readSessionField("currentThinkingLevel", "medium");
			},
			set currentThinkingLevel(value) {
				this.writeSessionField(
					"currentThinkingLevel",
					typeof value === "string" ? value : "medium",
				);
			},

			get isStreaming() {
				return this.readSessionField("isStreaming", false);
			},
			set isStreaming(value) {
				this.writeSessionField("isStreaming", Boolean(value));
			},

			get sessionStats() {
				return this.readSessionField("sessionStats", () =>
					createDefaultSessionStats(),
				);
			},
			set sessionStats(value) {
				this.writeSessionField(
					"sessionStats",
					value && typeof value === "object"
						? {
								...createDefaultSessionStats(),
								...value,
							}
						: createDefaultSessionStats(),
				);
			},

			get usageAccountedMessageIds() {
				return this.readSessionField(
					"usageAccountedMessageIds",
					() => new Set(),
				);
			},
			set usageAccountedMessageIds(value) {
				this.writeSessionField(
					"usageAccountedMessageIds",
					value instanceof Set ? value : new Set(),
				);
			},

			get pendingModelChange() {
				return this.readSessionField("pendingModelChange", null);
			},
			set pendingModelChange(value) {
				this.writeSessionField("pendingModelChange", value ?? null);
			},

			get extensionStatus() {
				return this.readSessionField("extensionStatus", "");
			},
			set extensionStatus(value) {
				this.writeSessionField(
					"extensionStatus",
					typeof value === "string" ? value : "",
				);
			},

			get recoveringRpcSession() {
				return this.readSessionField("recoveringRpcSession", false);
			},
			set recoveringRpcSession(value) {
				this.writeSessionField("recoveringRpcSession", Boolean(value));
			},

			get replayingPendingRpc() {
				return this.readSessionField("replayingPendingRpc", false);
			},
			set replayingPendingRpc(value) {
				this.writeSessionField("replayingPendingRpc", Boolean(value));
			},

			get lastRpcEventSeq() {
				return this.readSessionField("lastEventSeq", 0);
			},
			set lastRpcEventSeq(value) {
				const next = Number(value);
				this.writeSessionField(
					"lastEventSeq",
					Number.isFinite(next) ? next : 0,
				);
			},

			get pendingRpcCommands() {
				return this.readSessionField("pendingRpcCommands", () => new Map());
			},
			set pendingRpcCommands(value) {
				this.writeSessionField(
					"pendingRpcCommands",
					value instanceof Map ? value : new Map(),
				);
			},

			userScrolledUp: false,
			_programmaticScrollUntil: 0,
			_prevScrollTop: null,
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

			async init() {
				this.theme = localStorage.getItem("rho-theme") || "dark";
				if (this.theme === "light") {
					document.body.classList.add("theme-light");
				}
				marked.setOptions({ gfm: true, breaks: true });
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
			},
			...rhoChatInputRpcMethods,
			...rhoChatRpcEventMethods,
			...rhoChatStreamingMethods,
			...rhoChatSessionUiMethods,
			...rhoChatSessionActionMethods,
			...rhoChatSlashAndStatsMethods,
			...rhoChatModelAndExtensionMethods,
			...rhoChatGitContextMethods,
			...rhoChatSessionRestoreMethods,
			...rhoChatDialogAndFocusMethods,
		}));
	});
}
