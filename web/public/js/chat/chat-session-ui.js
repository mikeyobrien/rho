import * as primitives from "./constants-and-primitives.js";
import * as modelThinking from "./model-thinking-and-toast.js";
import * as renderingUsage from "./rendering-and-usage.js";
import * as toolSemantics from "./tool-semantics.js";

const {
	CHAT_REFRESH_INTERVAL,
	parseToolSemantic,
	semanticHeaderSummary,
	semanticOutputSummary,
	formatTimestamp,
	highlightCodeBlocks,
	normalizeMessage,
	fetchJson,
	toIsoTimestamp,
} = { ...primitives, ...toolSemantics, ...renderingUsage, ...modelThinking };

export const rhoChatSessionUiMethods = {
	handleMessageEnd(event) {
		const message = event.message;
		const role = String(message?.role ?? "");
		const messageId = String(message?.id ?? this.streamMessageId ?? "");

		if (role === "assistant") {
			const finalMessage = normalizeMessage({
				...(message ?? {}),
				id: messageId || `stream-${Date.now()}`,
				timestamp: toIsoTimestamp(message?.timestamp),
			});

			// Carry over tool outputs, durations, and semantic data from
			// streaming parts — the server's final message doesn't include
			// tool results (those arrive as separate toolResult messages).
			const idx = this.renderedMessages.findIndex(
				(item) =>
					item.id === finalMessage.id || item.id === this.streamMessageId,
			);
			if (idx >= 0) {
				const streamMsg = this.renderedMessages[idx];
				const streamToolParts = (streamMsg.parts ?? []).filter(
					(p) => p.type === "tool_call" && p.output,
				);
				for (const streamPart of streamToolParts) {
					// Match by toolCallId or by name+position
					const finalPart = finalMessage.parts.find(
						(p) =>
							p.type === "tool_call" &&
							!p.output &&
							((p.toolCallId && p.toolCallId === streamPart.toolCallId) ||
								p.name === streamPart.name),
					);
					if (finalPart) {
						finalPart.output = streamPart.output;
						finalPart.outputPreview = streamPart.outputPreview;
						finalPart.duration = streamPart.duration || finalPart.duration;
						finalPart.status = streamPart.status || finalPart.status;
						// Recompute semantic with the actual output
						const semantic = parseToolSemantic(
							finalPart.name,
							finalPart.args,
							finalPart.output,
						);
						if (semantic) {
							finalPart.semantic = semantic;
							const hs = semanticHeaderSummary(finalPart.name, semantic);
							if (hs) finalPart.argsSummary = hs;
							const os = semanticOutputSummary(
								finalPart.name,
								semantic,
								finalPart.output,
							);
							if (os) finalPart.outputPreview = os;
						}
					}
				}
				this.renderedMessages[idx] = finalMessage;
			} else {
				this.renderedMessages.push(finalMessage);
			}

			this.accumulateUsageFromMessage(message);
			this.streamMessageId = "";
			this.isSendingPrompt = false;
			this.$nextTick(() => {
				highlightCodeBlocks(this.$refs.thread);
				this.scrollThreadToBottom();
			});
			this.loadSessions(false);
			return;
		}

		this.upsertMessage(message);
	},

	appendBanner(type, text) {
		const partType =
			type === "error" ? "error" : type === "retry" ? "retry" : "compaction";
		const message = {
			id: `banner-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`,
			role: partType === "error" ? "error" : "summary",
			roleLabel: partType === "error" ? "error" : "system",
			timestamp: formatTimestamp(new Date().toISOString()),
			parts: [
				partType === "error"
					? { type: "error", key: `banner-${Date.now()}`, text }
					: partType === "retry"
						? { type: "retry", key: `banner-${Date.now()}`, summary: text }
						: {
								type: "compaction",
								key: `banner-${Date.now()}`,
								summary: text,
							},
			],
			usageData: { desktop: "", mobile: "" },
			canFork: false,
		};

		this.renderedMessages.push(message);
		this.scrollThreadToBottom();
	},

	scrollThreadToBottom() {
		if (this.userScrolledUp) return;
		// Set guard IMMEDIATELY so scroll events fired during Alpine's
		// DOM rerender (before the rAF) are ignored
		this._programmaticScrollUntil = Date.now() + 300;
		this.$nextTick(() => {
			requestAnimationFrame(() => {
				const thread = this.$refs.thread;
				if (!thread) return;
				// Refresh guard for the actual scroll operation
				this._programmaticScrollUntil = Date.now() + 150;
				thread.scrollTop = thread.scrollHeight;
			});
		});
	},

	isChatViewVisible() {
		if (document.hidden) {
			return false;
		}
		const chatView = this.$root?.closest?.(".chat-view");
		if (!chatView) {
			return true;
		}
		return chatView.offsetParent !== null;
	},

	startPolling() {
		this.stopPolling();
		this.poller = setInterval(() => {
			if (!this.isChatViewVisible()) {
				return;
			}
			this.loadSessions(false);
		}, CHAT_REFRESH_INTERVAL);
	},

	stopPolling() {
		if (this.poller) {
			clearInterval(this.poller);
			this.poller = null;
		}
	},

	setupIdleDetection() {
		// Track user activity
		const updateActivity = () => {
			this.lastActivityTime = Date.now();
			if (this.isIdle) {
				this.isIdle = false;
				// Resume polling when becoming active
				if (this.isPageVisible) {
					this.startPolling();
				}
			}
		};

		// Listen for user interactions
		document.addEventListener("mousemove", updateActivity);
		document.addEventListener("mousedown", updateActivity);
		document.addEventListener("keydown", updateActivity);
		document.addEventListener("touchstart", updateActivity);
		document.addEventListener("scroll", updateActivity);

		// Check for idle every 30 seconds
		this.idleCheckInterval = setInterval(() => {
			const idleTimeout = 5 * 60 * 1000; // 5 minutes
			if (Date.now() - this.lastActivityTime > idleTimeout) {
				if (!this.isIdle) {
					this.isIdle = true;
					this.stopPolling(); // Stop polling when idle
				}
			}
		}, 30000);
	},

	setupVisibilityDetection() {
		// Pause polling when tab is hidden
		const handleVisibilityChange = () => {
			this.isPageVisible = !document.hidden;
			if (document.hidden) {
				this.stopPolling();
			} else if (!this.isIdle) {
				// Resume polling when tab becomes visible (if not idle)
				this.loadSessions(false); // Fetch immediately
				this.startPolling();
				// Reconnect WebSocket immediately if it died while hidden
				// (browsers throttle timers in background tabs)
				if (!this.isWsConnected) {
					this.manualReconnect();
				}
			}
		};

		document.addEventListener("visibilitychange", handleVisibilityChange);
	},

	sessionsTotal: 0,
	sessionsLoaded: 0,
	sessionsPageSize: 20,
	isLoadingMore: false,
	allSessionsLoaded: false,

	async loadSessions(showSpinner = true) {
		if (showSpinner) {
			this.isLoadingSessions = true;
		}
		this.error = "";

		try {
			const resp = await fetch(
				`/api/sessions?limit=${this.sessionsPageSize}&offset=0`,
			);
			const total = Number.parseInt(
				resp.headers.get("X-Total-Count") ?? "0",
				10,
			);
			const sessions = await resp.json();
			this.sessions = sessions;
			this.sessionsTotal = total;
			this.sessionsLoaded = sessions.length;
			this.allSessionsLoaded = sessions.length >= total;

			if (this.activeSessionId) {
				// Only load session on first load (not on poll refresh)
				if (showSpinner) {
					await this.selectSession(this.activeSessionId, {
						updateHash: false,
					});
				}
			} else if (showSpinner && sessions.length > 0) {
				// Auto-select latest on first load, but don't rewrite the URL.
				await this.selectSession(sessions[0].id, { updateHash: false });
			}
		} catch (error) {
			this.error = error.message ?? "Failed to load sessions";
		} finally {
			this.isLoadingSessions = false;
		}
	},

	async loadMoreSessions() {
		if (this.isLoadingMore || this.allSessionsLoaded) return;
		this.isLoadingMore = true;
		try {
			const resp = await fetch(
				`/api/sessions?limit=${this.sessionsPageSize}&offset=${this.sessionsLoaded}`,
			);
			const more = await resp.json();
			if (more.length === 0) {
				this.allSessionsLoaded = true;
			} else {
				// Deduplicate by ID
				const existingIds = new Set(this.sessions.map((s) => s.id));
				const newSessions = more.filter((s) => !existingIds.has(s.id));
				this.sessions = [...this.sessions, ...newSessions];
				this.sessionsLoaded += more.length;
				this.allSessionsLoaded = this.sessionsLoaded >= this.sessionsTotal;
			}
		} catch (_error) {
			// Silent fail on load-more
		} finally {
			this.isLoadingMore = false;
		}
	},

	onSessionsScroll(event) {
		const el = event.target;
		if (el.scrollTop + el.clientHeight >= el.scrollHeight - 50) {
			this.loadMoreSessions();
		}
	},

	async reloadActiveSession() {
		if (!this.activeSessionId) {
			return;
		}
		await this.selectSession(this.activeSessionId);
	},

	toggleSessionsPanel() {
		this.showSessionsPanel = !this.showSessionsPanel;
	},

	resetSlashCommandsCache() {
		this.slashCommands = [];
		this.slashCommandIndex = new Map();
		this.slashCommandsLoaded = false;
		this.slashCommandsLoading = false;
		this.pendingSlashClassification = null;
		this.closeSlashAutocomplete();
	},

	clearSelectedSession() {
		this.activeSessionId = "";
		this.activeSession = null;
		this.renderedMessages = [];
		this.allNormalizedMessages = [];
		this.streamMessageId = "";
		this.error = "";
		this.isLoadingSession = false;
		this.userScrolledUp = false;
		this._prevScrollTop = null;
		this.promptQueue = [];
		this.toolCallPartById.clear();
		this.usageAccountedMessageIds.clear();
		this.sessionStats = {
			tokens: 0,
			cost: 0,
			inputTokens: 0,
			outputTokens: 0,
			cacheRead: 0,
			cacheWrite: 0,
		};
		this.updateFooter();

		// Clear stale RPC
		this.activeRpcSessionId = "";
		this.activeRpcSessionFile = "";
		this.lastRpcEventSeq = 0;
		this.recoveringRpcSession = false;
		this.replayingPendingRpc = false;
		this.pendingRpcCommands.clear();
		this.resetSlashCommandsCache();
		this.showReconnectBanner = false;
		this.reconnectBannerMessage = "";
		this.streamDisconnectedDuringResponse = false;
		this.awaitingStreamReconnectState = false;

		// Clear URL hash
		if (window.location.hash) {
			history.replaceState(
				null,
				"",
				window.location.pathname + window.location.search,
			);
		}

		// Open sessions panel so user can pick one
		this.showSessionsPanel = true;
	},

	async selectSession(sessionId, options = {}) {
		if (!sessionId) {
			return;
		}

		const updateHash = options.updateHash !== false;

		this.activeSessionId = sessionId;
		this.isLoadingSession = true;
		this.error = "";
		this.streamMessageId = "";
		this.userScrolledUp = false;
		this._prevScrollTop = null;
		this.toolCallPartById.clear();
		this.usageAccountedMessageIds.clear();
		this.sessionStats = {
			tokens: 0,
			cost: 0,
			inputTokens: 0,
			outputTokens: 0,
			cacheRead: 0,
			cacheWrite: 0,
		};
		this.updateFooter();

		// Clear stale RPC when switching sessions
		this.activeRpcSessionId = "";
		this.activeRpcSessionFile = "";
		this.lastRpcEventSeq = 0;
		this.recoveringRpcSession = false;
		this.replayingPendingRpc = false;
		this.pendingRpcCommands.clear();
		this.resetSlashCommandsCache();
		this.showReconnectBanner = false;
		this.reconnectBannerMessage = "";
		this.streamDisconnectedDuringResponse = false;
		this.awaitingStreamReconnectState = false;

		// Persist in URL for refresh/back (optional)
		if (updateHash && window.location.hash !== `#${sessionId}`) {
			history.replaceState(null, "", `#${sessionId}`);
		}

		// Close sessions panel after selection
		this.showSessionsPanel = false;

		try {
			const session =
				options.session ?? (await fetchJson(`/api/sessions/${sessionId}`));
			this.applySession(session);

			// Auto-start RPC so the session is immediately usable (not read-only)
			const sessionFile =
				options.sessionFile || session.file || this.getSessionFile(sessionId);
			if (sessionFile) {
				this.activeRpcSessionFile = sessionFile;
				this.startRpcSession(sessionFile);
			} else {
				this.isForking = false;
			}
		} catch (error) {
			this.error = error.message ?? "Failed to load session";
		} finally {
			this.isLoadingSession = false;
		}
	},
};
