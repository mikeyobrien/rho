import * as primitives from "./constants-and-primitives.js";
import * as modelThinking from "./model-thinking-and-toast.js";
import * as renderingUsage from "./rendering-and-usage.js";
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
			// Guard against double-init (Alpine re-init / HMR)
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

	// Lazy markdown rendering via IntersectionObserver
	setupLazyRendering() {
		this.$nextTick(() => {
			const thread = this.$refs.thread;
			if (!thread) return;

			// Guard against double-init
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

						// Find and render the message
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

						// Stop observing once rendered
						this._lazyObserver?.unobserve(msgEl);
					}
				},
				{ rootMargin: "200px" }, // Pre-render 200px before visible
			);

			// Observe all message elements
			for (const el of thread.querySelectorAll("[data-message-id]")) {
				this._lazyObserver?.observe(el);
			}
		});
	},

	setupKeyboardShortcuts() {
		document.addEventListener("keydown", (e) => {
			if (e.key === "Escape") {
				// Close dialogs first
				if (this.extensionDialog) {
					this.dismissDialog(null);
					e.preventDefault();
					return;
				}
			}
		});
	},

	handleComposerKeydown(e) {
		// Slash autocomplete intercepts first
		if (this.handleSlashAcKeydown(e)) {
			return;
		}
		// Enter to send (without shift)
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
		// Only show drop zone if dragging files that include images
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
		// Debounce drag leave to avoid flicker when moving between child elements
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
		// Focus the composer after dropping images
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
		// Reset input so the same file can be re-selected
		event.target.value = "";
	},

	addImageFile(file) {
		const reader = new FileReader();
		reader.onload = () => {
			const dataUrl = reader.result;
			// Extract base64 data (strip "data:image/png;base64," prefix)
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

		// Always track position, even during programmatic scrolls
		const prevTop = this._prevScrollTop;
		this._prevScrollTop = el.scrollTop;

		// Ignore events from our own programmatic scrolling
		if (Date.now() < this._programmaticScrollUntil) return;

		const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;

		// Near the bottom → re-enable auto-scroll (also lets users
		// scroll back down to resume without clicking "New messages")
		if (distFromBottom <= 80) {
			this.userScrolledUp = false;
			return;
		}

		// Only mark scrolled-up when the user actively scrolled upward
		// by a meaningful amount (ignores content growing below and
		// tiny accidental trackpad impulses)
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
			} catch {
				// Ignore close errors on stale sockets.
			}
		}
		if (
			this.ws &&
			(this.ws.readyState === WebSocket.OPEN ||
				this.ws.readyState === WebSocket.CONNECTING)
		) {
			return;
		}

		// Clear any pending reconnect timer
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
			this.startWsHeartbeat();

			if (this.awaitingStreamReconnectState) {
				this.showReconnectBanner = true;
				this.reconnectBannerMessage = "Reconnected. Checking stream status…";
			} else {
				this.showReconnectBanner = false;
				this.reconnectBannerMessage = "";
			}

			const sessionFile =
				this.activeRpcSessionFile || this.getSessionFile(this.activeSessionId);

			if (this.activeRpcSessionId) {
				this.recoveringRpcSession = true;
				const resumed = this.sendWs(
					{
						type: "rpc_command",
						sessionId: this.activeRpcSessionId,
						lastEventSeq: this.lastRpcEventSeq,
						command: { type: "get_state" },
					},
					{ replayable: false },
				);
				if (resumed) {
					return;
				}
				this.recoveringRpcSession = false;
			}

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
			this.isWsConnected = false;
			// Error handling is done in close event
		});

		this.ws = ws;
	},

	scheduleReconnect() {
		this.wsReconnectAttempts++;
		this.showReconnectBanner = true;

		// Exponential backoff: 1s, 2s, 4s, 8s, 16s, max 30s
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

	startWsHeartbeat() {
		this.stopWsHeartbeat();
		this.wsPingTimer = setInterval(() => {
			if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
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
			typeof payload.command !== "object"
		) {
			return;
		}
		if (options.trackPending === false) {
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

		this.pendingRpcCommands.set(commandId, {
			payload: JSON.parse(JSON.stringify(payload)),
			queuedAt: Date.now(),
		});
	},
};
