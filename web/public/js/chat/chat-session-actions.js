import * as primitives from "./constants-and-primitives.js";
import * as modelThinking from "./model-thinking-and-toast.js";
import * as renderingUsage from "./rendering-and-usage.js";
import * as toolSemantics from "./tool-semantics.js";
const {
	slashContract,
	clampString,
	formatTimestamp,
	_formatTimestampShort,
	highlightCodeBlocks,
	normalizeMessage,
	postJson,
} = { ...primitives, ...toolSemantics, ...renderingUsage, ...modelThinking };
export const rhoChatSessionActionMethods = {
	applySession(session) {
		if (this.activeRpcSessionId && (this.isStreaming || this.isSendingPrompt)) {
			this.activeSession = {
				...this.activeSession,
				...session,
				messages: undefined,
			};
			return;
		}
		this.activeSession = session;

		const rawMessages = session.messages ?? [];
		const mergedMessages = [];
		for (let i = 0; i < rawMessages.length; i++) {
			const msg = rawMessages[i];
			if (
				msg.role === "toolResult" ||
				msg.role === "tool_result" ||
				msg.role === "tool"
			) {
				for (let j = mergedMessages.length - 1; j >= 0; j--) {
					if (mergedMessages[j].role === "assistant") {
						const content = mergedMessages[j].content;
						if (Array.isArray(content)) {
							const call = content.find(
								(c) =>
									(c.type === "toolCall" ||
										c.type === "tool_call" ||
										c.type === "tool_use") &&
									!c._merged,
							);
							if (call) {
								const resultText = Array.isArray(msg.content)
									? msg.content.map((c) => c.text ?? c.output ?? "").join("\n")
									: typeof msg.content === "string"
										? msg.content
										: "";
								call.output = resultText;
								call._merged = true;
							}
						}
						break;
					}
				}
				continue;
			}
			mergedMessages.push({ ...msg });
		}

		this.syncSessionStatsFromSession(session, mergedMessages);
		this.seedUsageAccumulator(mergedMessages);

		const seenIds = new Set();
		const allMessages = mergedMessages
			.map((msg) => normalizeMessage(msg, true))
			.filter((msg) => {
				if (!msg.parts || msg.parts.length === 0) {
					return false;
				}
				const hasContent = msg.parts.some((p) => {
					if (p.type === "text") return Boolean(p.content);
					if (p.type === "thinking") return Boolean(p.content);
					if (p.type === "tool_call") return Boolean(p.name || p.args);
					if (p.type === "tool_result") return Boolean(p.output);
					if (p.type === "bash") return Boolean(p.command || p.output);
					if (p.type === "error") return Boolean(p.text);
					if (
						p.type === "compaction" ||
						p.type === "summary" ||
						p.type === "retry"
					)
						return Boolean(p.summary);
					return true;
				});
				if (!hasContent) {
					return false;
				}
				if (seenIds.has(msg.id)) {
					return false;
				}
				seenIds.add(msg.id);
				return true;
			});

		const MESSAGE_CAP = 100;
		this.hasEarlierMessages = allMessages.length > MESSAGE_CAP;
		this.allNormalizedMessages = allMessages;
		this.renderedMessages = allMessages.slice(-MESSAGE_CAP);

		this.userScrolledUp = false;
		this.$nextTick(() => {
			highlightCodeBlocks(this.$refs.thread);
			this.scrollThreadToBottom();
			this.setupLazyRendering();
		});
	},

	sessionSummary(session) {
		if (!session) {
			return null;
		}
		const sessionId = session.header?.id ?? session.id ?? "";
		if (!sessionId || !Array.isArray(this.sessions)) {
			return null;
		}
		return (
			this.sessions.find((candidate) => candidate.id === sessionId) ?? null
		);
	},

	sessionLabel(session) {
		if (!session) {
			return "";
		}
		const summary = this.sessionSummary(session);
		const rawId = session.header?.id ?? session.id ?? summary?.id ?? "";
		const firstPrompt = session.firstPrompt ?? summary?.firstPrompt;
		return (
			session.name ||
			summary?.name ||
			(firstPrompt
				? clampString(firstPrompt, 50)
				: rawId
					? rawId.substring(0, 8)
					: "session")
		);
	},

	sessionTimestampLabel(session) {
		if (!session) {
			return "";
		}
		const summary = this.sessionSummary(session);
		return formatTimestamp(
			session.header?.timestamp ??
				session.timestamp ??
				summary?.timestamp ??
				"",
		);
	},

	threadMetaLabel(session) {
		const countLabel = this.messageCountLabel(session);
		const timestamp = this.sessionTimestampLabel(session);
		return timestamp ? `${timestamp} · ${countLabel}` : countLabel;
	},

	messageCountLabel(session) {
		if (!session) {
			return "";
		}
		// For the active session, prefer the live rendered count since
		// activeSession metadata goes stale during streaming
		const isActive =
			session === this.activeSession && this.renderedMessages.length > 0;
		const count = isActive
			? this.renderedMessages.length
			: (session.messageCount ??
				session.stats?.messageCount ??
				session.messages?.length ??
				0);
		return `${count} message${count === 1 ? "" : "s"}`;
	},

	formatTimestamp(value) {
		return formatTimestamp(value);
	},

	formatTimestampShort(value) {
		return _formatTimestampShort(value);
	},

	hasMessages() {
		return this.renderedMessages.length > 0;
	},

	loadEarlierMessages() {
		// Load earlier messages from the stored full message list
		if (
			!this.allNormalizedMessages ||
			this.allNormalizedMessages.length === 0
		) {
			this.showToast("No earlier messages available.", "info", 2500);
			return;
		}

		const currentFirstId = this.renderedMessages[0]?.id;
		if (!currentFirstId) {
			return;
		}

		// Find the index of the current first message in the full list
		let currentIndex = -1;
		for (let i = 0; i < this.allNormalizedMessages.length; i++) {
			if (this.allNormalizedMessages[i].id === currentFirstId) {
				currentIndex = i;
				break;
			}
		}

		if (currentIndex <= 0) {
			this.showToast("No earlier messages to load.", "info", 2500);
			return;
		}

		// Load up to 100 earlier messages
		const LOAD_COUNT = 100;
		const start = Math.max(0, currentIndex - LOAD_COUNT);
		const earlierMessages = this.allNormalizedMessages.slice(
			start,
			currentIndex,
		);

		// Prepend to renderedMessages
		this.renderedMessages = [...earlierMessages, ...this.renderedMessages];

		// Update hasEarlierMessages flag
		this.hasEarlierMessages = start > 0;

		// Set up lazy rendering for newly added messages
		this.$nextTick(() => {
			this.setupLazyRendering();
		});
	},

	getSessionFile(sessionId) {
		const s = this.sessions.find((s) => s.id === sessionId);
		return s?.file ?? "";
	},

	getActiveSessionFile() {
		return (
			this.activeRpcSessionFile ||
			this.activeSession?.file ||
			this.getSessionFile(this.activeSessionId)
		);
	},

	canStartEmptySession() {
		return Boolean(
			this.activeSession &&
				this.renderedMessages.length === 0 &&
				this.getActiveSessionFile(),
		);
	},

	isForkActive() {
		return Boolean(this.activeRpcSessionId);
	},

	isInteractiveSession() {
		return this.isForkActive() || this.canStartEmptySession();
	},

	sessionForkBadge(session) {
		if (!session?.parentSession) {
			return "";
		}
		return "fork";
	},

	sessionForkTitle(session) {
		return session?.parentSession ? `forked from ${session.parentSession}` : "";
	},

	canForkMessage(message) {
		const id = String(message?.id ?? "");
		if (id.startsWith("local-user-")) {
			return false;
		}
		return Boolean(message?.canFork && this.activeSessionId);
	},
	async newSession() {
		if (this.isForking) return;
		this.error = "";
		this.isForking = true;

		try {
			const result = await postJson("/api/sessions/new", {});
			this.activeSessionId = result.sessionId;
			this.publishActiveSession(result.sessionId);
			this.activeRpcSessionId = "";
			this.activeRpcSessionFile = result.sessionFile;
			this.lastRpcEventSeq = 0;
			this.recoveringRpcSession = false;
			this.replayingPendingRpc = false;
			this.pendingRpcCommands.clear();
			this.resetSlashCommandsCache();
			history.replaceState(null, "", `#${result.sessionId}`);
			this.promptText = "";
			this.renderedMessages = [];
			this.applySession(result.session);
			this.refreshGitProject();
			await this.loadSessions(false);
			this.startRpcSession(result.sessionFile);
		} catch (error) {
			this.error = error.message ?? "Failed to create session";
			this.isForking = false;
		}
	},
	async forkFromEntry(entryId) {
		if (!this.activeSessionId || !entryId || this.isForking) {
			return;
		}

		this.error = "";
		this.isForking = true;

		try {
			const forkResult = await postJson(
				`/api/sessions/${this.activeSessionId}/fork`,
				{ entryId },
			);

			this.promptText = "";

			// Navigate directly into the forked session so users can continue
			// chatting immediately without manual session switching.
			await this.selectSession(forkResult.sessionId, {
				session: forkResult.session,
				sessionFile: forkResult.sessionFile,
			});
			await this.loadSessions(false);
			this.showToast("Forked to new chat.", "success", 2200);

			// Reset scroll state and auto-scroll to bottom after fork
			this.userScrolledUp = false;
			this.scrollThreadToBottom();
		} catch (error) {
			this.error = error.message ?? "Failed to fork session";
			this.isForking = false;
		}
	},

	startRpcSession(sessionFile, options = {}) {
		const targetSessionId =
			typeof options.sessionId === "string"
				? options.sessionId.trim()
				: this.focusedSessionId;
		const targetState = targetSessionId
			? this.ensureSessionState(targetSessionId, {
					sessionFile: typeof sessionFile === "string" ? sessionFile : "",
				})
			: this.getFocusedSessionState();
		if (targetState) {
			targetState.status = "starting";
			targetState.error = "";
			targetState.lastActivityAt = Date.now();
		}

		const sent = this.sendWs({
			type: "rpc_command",
			sessionFile,
			sessionIdHint: targetSessionId || undefined,
			command: {
				type: "switch_session",
				sessionFile,
				sessionPath: sessionFile,
				path: sessionFile,
			},
		});
		this.persistSessionRestoreSnapshot();

		if (!sent) {
			this.isForking = false;
			if (targetState) {
				targetState.status = "error";
			}
		}
	},

	sendPromptMessage(message, promptOptions = {}, slashClassification = null) {
		const hasImages = this.pendingImages.length > 0;
		const sessionFile = this.getActiveSessionFile();
		if ((!message && !hasImages) || this.isSendingPrompt) {
			return;
		}
		if (!this.activeRpcSessionId && !sessionFile) {
			return;
		}

		this.error = "";
		this.isSendingPrompt = true;
		this.promptText = "";
		this.streamMessageId = "";
		this.userScrolledUp = false;
		this.pendingSlashClassification = slashClassification;
		this.closeSlashAutocomplete();

		// Capture and clear pending images
		const images = hasImages
			? this.pendingImages.map((img) => ({
					type: "image",
					data: img.data,
					mimeType: img.mimeType,
				}))
			: undefined;
		const imageDataUrls = hasImages
			? this.pendingImages.map((img) => img.dataUrl)
			: [];
		this.pendingImages = [];

		// Add user message locally before sending to RPC
		const localParts = [];
		if (message) {
			localParts.push({
				type: "text",
				render: "text",
				content: message,
				key: "text-0",
			});
		}
		imageDataUrls.forEach((dataUrl, i) => {
			localParts.push({ type: "image", dataUrl, key: `image-${i}` });
		});
		this.renderedMessages.push({
			id: `local-user-${Date.now()}`,
			role: "user",
			roleLabel: "USER",
			timestamp: new Date().toLocaleString(),
			parts: localParts,
			canFork: false,
		});
		this.scrollThreadToBottom();

		const rpcPayload = {
			type: "rpc_command",
			command: {
				type: "prompt",
				message: message || "Describe this image.",
				...promptOptions,
				...(images ? { images } : {}),
			},
		};

		if (this.activeRpcSessionId) {
			rpcPayload.sessionId = this.activeRpcSessionId;
		} else if (sessionFile) {
			rpcPayload.sessionFile = sessionFile;
			rpcPayload.sessionIdHint = this.activeSessionId || undefined;
			this.activeRpcSessionFile = sessionFile;
			this.isForking = true;
		}

		const sent = this.sendWs(rpcPayload);

		if (!sent) {
			this.isSendingPrompt = false;
			this.isForking = false;
		} else {
			this.$nextTick(() => {
				this.scrollThreadToBottom();
			});
		}

		if (this.shouldDismissKeyboardAfterSend()) {
			this.blurComposer();
		} else {
			this.focusComposer();
		}
	},

	sendPrompt() {
		const message = this.promptText.trim();
		if (!message) {
			return;
		}
		this.sendPromptMessage(message);
	},

	classifySlashPrompt(message) {
		return slashContract.classifySlashCommand(message, this.slashCommandIndex, {
			interactiveOnlyCommands: slashContract.INTERACTIVE_ONLY_SLASH_COMMANDS,
		});
	},

	sendSlashPrompt(message, classification) {
		const promptOptions = slashContract.resolvePromptOptions(
			classification,
			this.isStreaming,
			"steer",
		);
		this.sendPromptMessage(message, promptOptions, classification);
	},
};
