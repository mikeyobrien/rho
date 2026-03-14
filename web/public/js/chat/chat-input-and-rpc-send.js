import * as primitives from "./constants-and-primitives.js";
import * as modelThinking from "./model-thinking-and-toast.js";
import * as renderingUsage from "./rendering-and-usage.js";
import {
	bumpPendingRpcQueuedAt,
	hasStalePendingRpcCommands,
} from "./rpc-health-watchdog.js";
import { resumeReconnectSessions } from "./rpc-reconnect-runtime.js";
import * as toolSemantics from "./tool-semantics.js";

const { renderMarkdown, highlightCodeBlocks, buildWsUrl } = {
	...primitives,
	...toolSemantics,
	...renderingUsage,
	...modelThinking,
};

export const rhoChatInputRpcMethods = {
	setupPullToRefresh() {
		this.$nextTick(() => {
			const app = this.$root;
			if (!app || typeof PullToRefresh === "undefined") return;
			if (this._ptr) {
				this._ptr.destroy();
				this._ptr = null;
			}
			this._ptr = new PullToRefresh(app, {
				onRefresh: () => {
					window.location.reload();
				},
			});
		});
	},

	setupLazyRendering() {
		this.$nextTick(() => {
			const thread = this.$refs.thread;
			if (!thread) return;

			if (this._lazyObserver) {
				this._lazyObserver.disconnect();
			}

			this._lazyObserver = new IntersectionObserver(
				(entries) => {
					for (const entry of entries) {
						if (!entry.isIntersecting) continue;
						const msgEl = entry.target;
						const msgId = msgEl.dataset.messageId;
						if (!msgId) continue;

						const wasNearBottom = this.isThreadNearBottom(120);

						const msg = this.renderedMessages.find((m) => m.id === msgId);
						if (!msg || !msg.parts) continue;

						let modified = false;
						for (const part of msg.parts) {
							if (part.isRendered) continue;
							if (part.type === "thinking") {
								part.content = renderMarkdown(part.rawContent || part.content);
								part.isRendered = true;
								modified = true;
								continue;
							}
							if (part.type === "text") {
								if (part.render === "html") {
									part.content = renderMarkdown(
										part.rawContent || part.content,
									);
									modified = true;
								}
								part.isRendered = true;
							}
						}

						if (modified) {
							this.$nextTick(() => {
								highlightCodeBlocks(msgEl);
								if (wasNearBottom && !this.userScrolledUp) {
									this.scrollThreadToBottom();
								}
							});
						}

						this._lazyObserver?.unobserve(msgEl);
					}
				},
				{ rootMargin: "200px" }, // Pre-render 200px before visible
			);

			for (const el of thread.querySelectorAll("[data-message-id]")) {
				this._lazyObserver?.observe(el);
			}
		});
	},

	setupKeyboardShortcuts() {
		document.addEventListener("keydown", (e) => {
			if (e.key === "Escape") {
				if (this.extensionDialog) {
					this.dismissDialog(null);
					e.preventDefault();
					return;
				}
			}
		});
	},

	handleComposerKeydown(e) {
		if (this.handleSlashAcKeydown(e)) {
			return;
		}
		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			this.handlePromptSubmit();
		}
	},

	handleComposerInput(event) {
		const el = event.target;
		el.style.height = "auto";
		el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
		this.updateSlashAutocomplete();
	},

	handleComposerPaste(event) {
		const items = event.clipboardData?.items;
		if (!items) return;
		for (const item of items) {
			if (item.type.startsWith("image/")) {
				event.preventDefault();
				const file = item.getAsFile();
				if (file) this.addImageFile(file);
			}
		}
	},

	handleDragOver(event) {
		if (!event.dataTransfer?.types?.includes("Files")) return;
		event.preventDefault();
		event.dataTransfer.dropEffect = "copy";
		if (this.dragLeaveTimeout) {
			clearTimeout(this.dragLeaveTimeout);
			this.dragLeaveTimeout = null;
		}
		this.isDraggingOver = true;
	},

	handleDragLeave(event) {
		event.preventDefault();
		if (this.dragLeaveTimeout) clearTimeout(this.dragLeaveTimeout);
		this.dragLeaveTimeout = setTimeout(() => {
			this.isDraggingOver = false;
			this.dragLeaveTimeout = null;
		}, 100);
	},

	handleDrop(event) {
		event.preventDefault();
		this.isDraggingOver = false;
		if (this.dragLeaveTimeout) {
			clearTimeout(this.dragLeaveTimeout);
			this.dragLeaveTimeout = null;
		}
		const files = event.dataTransfer?.files;
		if (!files) return;
		let addedAny = false;
		for (const file of files) {
			if (file.type.startsWith("image/")) {
				this.addImageFile(file);
				addedAny = true;
			}
		}
		if (addedAny) {
			this.$nextTick(() => {
				this.$refs.composerInput?.focus();
			});
		}
	},

	handleImageSelect(event) {
		const files = event.target.files;
		if (!files) return;
		for (const file of files) {
			if (file.type.startsWith("image/")) {
				this.addImageFile(file);
			}
		}
		event.target.value = "";
	},

	addImageFile(file) {
		const reader = new FileReader();
		reader.onload = () => {
			const dataUrl = reader.result;
			const base64 = dataUrl.split(",")[1];
			this.pendingImages.push({
				dataUrl,
				data: base64,
				mimeType: file.type,
				name: file.name,
			});
		};
		reader.readAsDataURL(file);
	},

	removeImage(index) {
		this.pendingImages.splice(index, 1);
	},

	isThreadNearBottom(threshold = 80) {
		const el = this.$refs.thread;
		if (!el) return true;
		const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
		return distFromBottom <= threshold;
	},

	handleThreadScroll() {
		const el = this.$refs.thread;
		if (!el) return;

		const prevTop = this._prevScrollTop;
		this._prevScrollTop = el.scrollTop;

		if (Date.now() < this._programmaticScrollUntil) return;

		const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
		if (distFromBottom <= 80) {
			this.userScrolledUp = false;
			return;
		}

		if (typeof prevTop === "number" && el.scrollTop < prevTop - 10) {
			this.userScrolledUp = true;
		}
	},

	connectWebSocket(force = false) {
		if (force && this.ws) {
			const staleWs = this.ws;
			this.ws = null;
			this.isWsConnected = false;
			this.stopWsHeartbeat();
			try {
				staleWs.close();
			} catch {}
		}
		if (
			this.ws &&
			(this.ws.readyState === WebSocket.OPEN ||
				this.ws.readyState === WebSocket.CONNECTING)
		) {
			return;
		}

		if (this.wsReconnectTimer) {
			clearTimeout(this.wsReconnectTimer);
			this.wsReconnectTimer = null;
		}

		const ws = new WebSocket(buildWsUrl());

		ws.addEventListener("open", () => {
			if (this.ws !== ws) {
				return;
			}
			this.isWsConnected = true;
			this.wsReconnectAttempts = 0;
			this.error = "";
			this.wsLastPongAt = Date.now();
			this.startWsHeartbeat();

			if (this.awaitingStreamReconnectState) {
				this.showReconnectBanner = true;
				this.reconnectBannerMessage = "Reconnected. Checking stream status…";
			} else {
				this.showReconnectBanner = false;
				this.reconnectBannerMessage = "";
			}

			if (resumeReconnectSessions(this)) {
				return;
			}
			const sessionFile =
				this.activeRpcSessionFile || this.getSessionFile(this.activeSessionId);
			if (sessionFile) {
				this.startRpcSession(sessionFile);
			}
		});

		ws.addEventListener("message", (event) => {
			if (this.ws !== ws) {
				return;
			}
			this.handleWsMessage(event);
		});

		ws.addEventListener("close", () => {
			if (this.ws === ws) {
				this.stopWsHeartbeat();
				this.wsLastPongAt = 0;
				const lostDuringResponse = this.isStreaming || this.isSendingPrompt;
				if (lostDuringResponse) {
					this.streamDisconnectedDuringResponse = true;
					this.awaitingStreamReconnectState = true;
					this.reconnectBannerMessage =
						"Connection lost while agent was responding. Reconnecting…";
				} else if (!this.awaitingStreamReconnectState) {
					this.reconnectBannerMessage = "Connection lost. Reconnecting…";
				}
				this.ws = null;
				this.isWsConnected = false;
				this.showReconnectBanner = true;
				this.scheduleReconnect();
			}
		});

		ws.addEventListener("error", () => {
			if (this.ws !== ws) {
				return;
			}
			this.stopWsHeartbeat();
			this.wsLastPongAt = 0;
			this.isWsConnected = false;
		});

		this.ws = ws;
	},

	scheduleReconnect() {
		this.wsReconnectAttempts++;
		this.showReconnectBanner = true;

		const delay = Math.min(
			this.wsBaseReconnectDelay * 2 ** (this.wsReconnectAttempts - 1),
			this.wsMaxReconnectDelay,
		);

		this.wsReconnectTimer = setTimeout(() => {
			this.connectWebSocket();
		}, delay);
	},

	manualReconnect() {
		this.wsReconnectAttempts = 0;
		if (this.wsReconnectTimer) {
			clearTimeout(this.wsReconnectTimer);
			this.wsReconnectTimer = null;
		}
		this.showReconnectBanner = true;
		this.reconnectBannerMessage = "Retrying connection…";
		this.connectWebSocket(true);
	},

	isWsConnectionStale(now = Date.now()) {
		const lastPongAt = Number(this.wsLastPongAt ?? 0);
		if (!Number.isFinite(lastPongAt) || lastPongAt <= 0) {
			return false;
		}
		const staleAfterMs = Number(this.wsHeartbeatStaleMs ?? 45_000);
		const threshold =
			Number.isFinite(staleAfterMs) && staleAfterMs > 0 ? staleAfterMs : 45_000;
		return now - lastPongAt >= threshold;
	},

	startWsHeartbeat() {
		this.stopWsHeartbeat();
		this.wsPingTimer = setInterval(() => {
			if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
				return;
			}
			if (this.isWsConnectionStale()) {
				this.reconnectBannerMessage = "Connection stalled. Reconnecting…";
				this.showReconnectBanner = true;
				this.connectWebSocket(true);
				return;
			}
			if (hasStalePendingRpcCommands(this)) {
				bumpPendingRpcQueuedAt(this);
				this.reconnectBannerMessage =
					"Command response timed out. Reconnecting…";
				this.showReconnectBanner = true;
				this.connectWebSocket(true);
				return;
			}
			this.ws.send(
				JSON.stringify({
					type: "rpc_ping",
					ts: Date.now(),
				}),
			);
		}, 15000);
	},

	stopWsHeartbeat() {
		if (this.wsPingTimer) {
			clearInterval(this.wsPingTimer);
			this.wsPingTimer = null;
		}
	},

	nextRpcCommandId() {
		this.rpcCommandCounter += 1;
		return `rpc-${Date.now()}-${this.rpcCommandCounter}`;
	},

	isReplayableRpcCommand(commandType) {
		return (
			commandType === "prompt" ||
			commandType === "steer" ||
			commandType === "follow_up"
		);
	},

	prepareRpcPayload(payload) {
		if (
			!payload ||
			typeof payload !== "object" ||
			payload.type !== "rpc_command" ||
			!payload.command ||
			typeof payload.command !== "object"
		) {
			return payload;
		}

		const nextPayload = {
			...payload,
			command: {
				...payload.command,
			},
		};

		const commandId =
			typeof nextPayload.command.id === "string"
				? nextPayload.command.id.trim()
				: "";
		if (!commandId) {
			nextPayload.command.id = this.nextRpcCommandId();
		} else {
			nextPayload.command.id = commandId;
		}

		return nextPayload;
	},

	trackPendingRpcCommand(payload, options = {}) {
		if (
			!payload ||
			typeof payload !== "object" ||
			payload.type !== "rpc_command" ||
			!payload.command ||
			typeof payload.command !== "object" ||
			options.trackPending === false
		) {
			return;
		}

		const commandId =
			typeof payload.command.id === "string" ? payload.command.id : "";
		if (!commandId) {
			return;
		}
		const replayable =
			typeof options.replayable === "boolean"
				? options.replayable
				: this.isReplayableRpcCommand(payload.command.type);
		if (!replayable) {
			return;
		}

		let pendingMap = this.pendingRpcCommands;
		const rpcSessionId =
			typeof payload.sessionId === "string" ? payload.sessionId.trim() : "";
		const sessionFile =
			typeof payload.sessionFile === "string" ? payload.sessionFile.trim() : "";
		if ((rpcSessionId || sessionFile) && this.sessionStateById instanceof Map) {
			for (const state of this.sessionStateById.values()) {
				const matchesRpc = rpcSessionId && state?.rpcSessionId === rpcSessionId;
				const matchesFile = !rpcSessionId && sessionFile === state?.sessionFile;
				if (!matchesRpc && !matchesFile) {
					continue;
				}
				if (state.pendingRpcCommands instanceof Map) {
					pendingMap = state.pendingRpcCommands;
				}
				break;
			}
		}

		pendingMap.set(commandId, {
			payload: JSON.parse(JSON.stringify(payload)),
			queuedAt: Date.now(),
		});
	},
};
