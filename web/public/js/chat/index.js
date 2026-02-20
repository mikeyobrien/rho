import { rhoChatDialogAndFocusMethods } from "./chat-dialog-and-focus.js";
import { rhoChatInputRpcMethods } from "./chat-input-and-rpc-send.js";
import { rhoChatModelAndExtensionMethods } from "./chat-model-and-extension-ui.js";
import { rhoChatRpcEventMethods } from "./chat-rpc-event-routing.js";
import { rhoChatSessionActionMethods } from "./chat-session-actions.js";
import { rhoChatSessionUiMethods } from "./chat-session-ui.js";
import { rhoChatSlashAndStatsMethods } from "./chat-slash-and-stats.js";
import { rhoChatStreamingMethods } from "./chat-streaming-parts.js";
import { THINKING_LEVELS_BASE } from "./rendering-and-usage.js";

export function registerRhoChat() {
	document.addEventListener("alpine:init", () => {
		Alpine.data("rhoChat", () => ({
			sessions: [],
			activeSessionId: "",
			activeSession: null,
			renderedMessages: [],
			isLoadingSessions: false,
			isLoadingSession: false,
			isForking: false,
			isSendingPrompt: false,
			error: "",
			poller: null,
			ws: null,
			activeRpcSessionId: "",
			activeRpcSessionFile: "",
			promptText: "",
			slashCommands: [],
			slashCommandIndex: new Map(),
			slashCommandsLoading: false,
			slashCommandsLoaded: false,
			pendingSlashClassification: null,
			slashAcVisible: false,
			slashAcItems: [],
			slashAcIndex: 0,
			streamMessageId: "",
			hasEarlierMessages: false,
			allNormalizedMessages: [],
			markdownRenderQueue: new Map(),
			markdownTimeout: null,
			toolCallPartById: new Map(),
			showSessionsPanel: false,
			promptQueue: [],
			showQueue: false,

			toggleTheme() {
				this.theme = this.theme === "light" ? "dark" : "light";
				document.body.classList.toggle("theme-light", this.theme === "light");
				localStorage.setItem("rho-theme", this.theme);
			},

			userScrolledUp: false,
			_programmaticScrollUntil: 0,
			_prevScrollTop: null,
			pendingImages: [],
			isDraggingOver: false,
			dragLeaveTimeout: null,
			availableModels: [],
			thinkingLevels: [...THINKING_LEVELS_BASE],
			currentModel: null,
			currentThinkingLevel: "medium",
			isStreaming: false,
			sessionStats: { tokens: 0, cost: 0 },
			usageAccountedMessageIds: new Set(),
			pendingModelChange: null,
			extensionDialog: null,
			extensionWidget: null,
			extensionStatus: "",
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
			recoveringRpcSession: false,
			replayingPendingRpc: false,
			lastRpcEventSeq: 0,
			rpcCommandCounter: 0,
			pendingRpcCommands: new Map(),
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
				if (hashId) {
					this.activeSessionId = hashId;
				}
				this.setupIdleDetection();
				this.setupVisibilityDetection();
				await this.loadSessions();
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
			...rhoChatDialogAndFocusMethods,
		}));
	});
}
