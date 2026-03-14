import * as primitives from "./constants-and-primitives.js";
import * as modelThinking from "./model-thinking-and-toast.js";
import * as renderingUsage from "./rendering-and-usage.js";
import * as toolSemantics from "./tool-semantics.js";

const {
	safeString,
	clampString,
	generateOutputPreview,
	parseToolSemantic,
	semanticHeaderSummary,
	semanticOutputSummary,
	renderMarkdown,
	highlightCodeBlocks,
	normalizeMessage,
	toIsoTimestamp,
	findToolCallInMessage,
	extractToolOutput,
} = { ...primitives, ...toolSemantics, ...renderingUsage, ...modelThinking };

export const rhoChatStreamingMethods = {
	upsertMessage(rawMessage) {
		if (!rawMessage || typeof rawMessage !== "object") {
			return;
		}

		const messageId = String(rawMessage.id ?? "");
		if (!messageId) {
			return;
		}

		const role = String(rawMessage.role ?? "");
		if (role === "assistant") {
			return;
		}

		if (role === "toolResult" || role === "tool_result" || role === "tool") {
			const resultOutput = extractToolOutput(rawMessage);
			const toolCallId = rawMessage.toolCallId ?? rawMessage.tool_use_id ?? "";
			if (resultOutput) {
				for (let j = this.renderedMessages.length - 1; j >= 0; j--) {
					const msg = this.renderedMessages[j];
					if (msg.role !== "assistant") continue;
					const part =
						msg.parts.find(
							(p) =>
								p.type === "tool_call" &&
								!p.output &&
								(toolCallId ? p.toolCallId === toolCallId : true),
						) ?? msg.parts.find((p) => p.type === "tool_call" && !p.output);
					if (part) {
						part.output = resultOutput;
						part.outputPreview = generateOutputPreview(resultOutput);
						part.status = rawMessage.isError ? "error" : "done";
						const semantic = parseToolSemantic(
							part.name,
							part.args,
							resultOutput,
						);
						if (semantic) {
							part.semantic = semantic;
							const hs = semanticHeaderSummary(part.name, semantic);
							if (hs) part.argsSummary = hs;
							const os = semanticOutputSummary(
								part.name,
								semantic,
								resultOutput,
							);
							if (os) part.outputPreview = os;
						}
					}
					break;
				}
			}
			return;
		}

		const normalized = normalizeMessage({
			...rawMessage,
			id: messageId,
			timestamp: toIsoTimestamp(rawMessage.timestamp),
		});

		if (!normalized.parts || normalized.parts.length === 0) {
			return;
		}
		const hasContent = normalized.parts.some((p) => {
			if (p.type === "text") return Boolean(p.content);
			if (p.type === "thinking") return Boolean(p.content);
			if (p.type === "tool_call") return Boolean(p.name || p.args);
			if (p.type === "tool_result") return Boolean(p.output);
			if (p.type === "bash") return Boolean(p.command || p.output);
			if (p.type === "error") return Boolean(p.text);
			if (p.type === "compaction" || p.type === "summary" || p.type === "retry")
				return Boolean(p.summary);
			return true;
		});
		if (!hasContent) {
			return;
		}

		const idx = this.renderedMessages.findIndex(
			(item) => item.id === messageId,
		);
		if (idx >= 0) {
			this.renderedMessages[idx] = normalized;
		} else {
			this.renderedMessages.push(normalized);
		}

		this.$nextTick(() => {
			highlightCodeBlocks(this.$refs.thread);
			this.scrollThreadToBottom();
		});
	},

	ensureStreamingMessage(eventMessage) {
		const eventId = String(eventMessage?.id ?? "");
		const messageId = this.streamMessageId || eventId || `stream-${Date.now()}`;
		if (!this.streamMessageId) {
			this.streamMessageId = messageId;
		}

		let message = this.renderedMessages.find((item) => item.id === messageId);
		if (!message) {
			const normalized = normalizeMessage({
				id: messageId,
				role: "assistant",
				timestamp: toIsoTimestamp(eventMessage?.timestamp),
				content: "",
				model: eventMessage?.model,
			});
			message = {
				...normalized,
				rawAssistantMessage: {
					id: messageId,
					role: "assistant",
					content: [],
					timestamp: toIsoTimestamp(eventMessage?.timestamp),
					model: eventMessage?.model,
				},
				stream: {
					sourceMessageId: eventId,
					textBuffers: {},
					thinkingBuffers: {},
					toolCallBuffers: {},
				},
			};
			this.renderedMessages.push(message);
		}

		const sourceMessageId =
			eventId && eventId !== messageId
				? eventId
				: (message.stream?.sourceMessageId ?? eventId);
		if (!message.stream || message.stream.sourceMessageId !== sourceMessageId) {
			message.stream = {
				sourceMessageId,
				textBuffers: {},
				thinkingBuffers: {},
				toolCallBuffers: {},
			};
		}

		if (!message.rawAssistantMessage) {
			message.rawAssistantMessage = {
				id: messageId,
				role: "assistant",
				content: [],
				timestamp: toIsoTimestamp(eventMessage?.timestamp),
				model: eventMessage?.model,
			};
		}

		return message;
	},

	ensurePart(message, key, createPart) {
		const idx = message.parts.findIndex((part) => part.key === key);
		if (idx >= 0) {
			return message.parts[idx];
		}
		const next = createPart();
		message.parts.push(next);
		return next;
	},

	streamPartKey(message, partType, contentIndex) {
		const sourceId = message?.stream?.sourceMessageId || "active";
		return `${message.id}-stream-${partType}-${sourceId}-${contentIndex}`;
	},

	indexToolCallParts(message) {
		if (!message || !Array.isArray(message.parts)) {
			return;
		}
		for (const part of message.parts) {
			if (part.type === "tool_call" && part.toolCallId) {
				this.toolCallPartById.set(part.toolCallId, {
					messageId: message.id,
					key: part.key,
				});
			}
		}
	},

	scheduleMarkdownRender(message, contentIndex) {
		const messageId = message?.id ?? "";
		if (!messageId) {
			return;
		}
		const sourceId = message?.stream?.sourceMessageId || "active";
		const key = `${sourceId}:${contentIndex}`;
		if (!this.markdownRenderQueue.has(messageId)) {
			this.markdownRenderQueue.set(messageId, new Set());
		}
		this.markdownRenderQueue.get(messageId).add(key);

		if (this.markdownTimeout != null) {
			return;
		}

		this.markdownTimeout = setTimeout(() => {
			this.markdownTimeout = null;
			this.flushMarkdownRender();
		}, 100);
	},

	flushMarkdownRender() {
		this.markdownFrame = null;

		for (const [messageId, indexes] of this.markdownRenderQueue.entries()) {
			const message = this.renderedMessages.find(
				(item) => item.id === messageId,
			);
			if (!message?.stream) {
				continue;
			}

			for (const indexKey of indexes) {
				const [sourceId, index] = String(indexKey).split(":");
				if ((message.stream.sourceMessageId || "active") !== sourceId) {
					continue;
				}
				const text = message.stream.textBuffers[index] ?? "";
				const partKey = this.streamPartKey(message, "text", index);
				const part = this.ensurePart(message, partKey, () => ({
					type: "text",
					key: partKey,
					render: "text",
					content: "",
				}));
				part.render = "text";
				part.content = text;
			}
		}

		this.markdownRenderQueue.clear();
		this.scrollThreadToBottom();
	},

	handleAssistantDelta(event) {
		const message = this.ensureStreamingMessage(event.message);
		const delta = event.assistantMessageEvent ?? {};
		const deltaType = delta.type;
		const contentIndex = String(delta.contentIndex ?? 0);

		if (deltaType === "text_start") {
			message.stream.textBuffers[contentIndex] = "";
			this.scheduleMarkdownRender(message, contentIndex);
			return;
		}

		if (deltaType === "text_delta") {
			message.stream.textBuffers[contentIndex] =
				(message.stream.textBuffers[contentIndex] ?? "") +
				String(delta.delta ?? "");
			this.scheduleMarkdownRender(message, contentIndex);
			return;
		}

		if (deltaType === "text_end") {
			if (typeof delta.content === "string") {
				message.stream.textBuffers[contentIndex] = delta.content;
			}
			this.scheduleMarkdownRender(message, contentIndex);
			return;
		}

		if (deltaType === "thinking_start") {
			message.stream.thinkingBuffers[contentIndex] = "";
			const key = this.streamPartKey(message, "thinking", contentIndex);
			this.ensurePart(message, key, () => ({
				type: "thinking",
				key,
				content: "",
			}));
			this.scrollThreadToBottom();
			return;
		}

		if (deltaType === "thinking_delta" || deltaType === "thinking_end") {
			const nextText =
				deltaType === "thinking_end" && typeof delta.content === "string"
					? delta.content
					: (message.stream.thinkingBuffers[contentIndex] ?? "") +
						String(delta.delta ?? "");
			message.stream.thinkingBuffers[contentIndex] = nextText;

			const key = this.streamPartKey(message, "thinking", contentIndex);
			const part = this.ensurePart(message, key, () => ({
				type: "thinking",
				key,
				content: "",
			}));
			part.content = renderMarkdown(nextText);

			this.scrollThreadToBottom();
			return;
		}

		if (deltaType === "toolcall_start") {
			message.stream.toolCallBuffers[contentIndex] = "";
			const key = this.streamPartKey(message, "tool", contentIndex);
			this.ensurePart(message, key, () => ({
				type: "tool_call",
				key,
				name: "tool",
				args: "",
				argsSummary: "",
				output: "",
				outputPreview: "",
				status: "running",
				duration: "",
				startTime: Date.now(),
			}));
			return;
		}

		if (deltaType === "toolcall_delta" || deltaType === "toolcall_end") {
			const chunk = String(delta.delta ?? "");
			message.stream.toolCallBuffers[contentIndex] =
				(message.stream.toolCallBuffers[contentIndex] ?? "") + chunk;

			const key = this.streamPartKey(message, "tool", contentIndex);
			const part = this.ensurePart(message, key, () => ({
				type: "tool_call",
				key,
				name: "tool",
				args: "",
				argsSummary: "",
				output: "",
				outputPreview: "",
				status: "running",
				duration: "",
				startTime: Date.now(),
			}));

			const fullToolCall =
				delta.toolCall ??
				delta.partial?.content?.[Number(contentIndex)] ??
				findToolCallInMessage(event.message, contentIndex);

			const argsText = fullToolCall?.arguments
				? safeString(fullToolCall.arguments)
				: (message.stream.toolCallBuffers[contentIndex] ?? "");

			part.name = fullToolCall?.name ?? part.name ?? "tool";
			part.toolCallId = fullToolCall?.id ?? part.toolCallId;
			part.args = argsText;
			part.argsSummary = clampString(argsText.replace(/\s+/g, " ").trim(), 120);
			part.status = deltaType === "toolcall_end" ? "done" : "running";

			if (part.toolCallId) {
				this.toolCallPartById.set(part.toolCallId, {
					messageId: message.id,
					key,
				});
			}

			this.scrollThreadToBottom();
		}
	},

	handleToolExecutionStart(event) {
		const message = this.ensureStreamingMessage({ id: this.streamMessageId });
		const toolCallId = String(event.toolCallId ?? `tool-${Date.now()}`);
		const key = `${message.id}-tool-exec-${toolCallId}`;
		const argsText = safeString(event.args ?? "");
		const part = this.ensurePart(message, key, () => ({
			type: "tool_call",
			key,
			name: event.toolName ?? "tool",
			args: argsText,
			argsSummary: clampString(argsText.replace(/\s+/g, " ").trim(), 120),
			output: "",
			outputPreview: "",
			status: "running",
			toolCallId,
			duration: "",
			startTime: Date.now(),
		}));

		part.name = event.toolName ?? part.name ?? "tool";
		part.args = argsText;
		part.argsSummary = clampString(argsText.replace(/\s+/g, " ").trim(), 120);
		part.status = "running";
		part.toolCallId = toolCallId;
		part.startTime = Date.now();

		this.toolCallPartById.set(toolCallId, { messageId: message.id, key });
		this.scrollThreadToBottom();
	},

	findToolCallPart(toolCallId) {
		const ref = this.toolCallPartById.get(toolCallId);
		if (!ref) {
			return null;
		}
		const message = this.renderedMessages.find(
			(item) => item.id === ref.messageId,
		);
		if (!message) {
			return null;
		}
		return message.parts.find((part) => part.key === ref.key) ?? null;
	},

	handleToolExecutionUpdate(event) {
		const toolCallId = String(event.toolCallId ?? "");
		if (!toolCallId) {
			return;
		}

		let part = this.findToolCallPart(toolCallId);
		if (!part) {
			this.handleToolExecutionStart(event);
			part = this.findToolCallPart(toolCallId);
		}
		if (!part) {
			return;
		}

		part.status = "running";
		const output = extractToolOutput(event.partialResult);
		part.output = output;
		part.outputPreview = generateOutputPreview(output);
		this.scrollThreadToBottom();
	},

	handleToolExecutionEnd(event) {
		const toolCallId = String(event.toolCallId ?? "");
		if (!toolCallId) {
			return;
		}

		let part = this.findToolCallPart(toolCallId);
		if (!part) {
			this.handleToolExecutionStart(event);
			part = this.findToolCallPart(toolCallId);
		}
		if (!part) {
			return;
		}

		part.status = event.isError ? "error" : "done";
		const output = extractToolOutput(event.result);
		part.output = output;
		part.outputPreview = generateOutputPreview(output);

		const argsText = part.args ?? "";
		const toolName = part.name ?? "";
		const semantic = parseToolSemantic(toolName, argsText, output);
		if (semantic) {
			part.semantic = semantic;
			const headerSummary = semanticHeaderSummary(toolName, semantic);
			if (headerSummary) {
				part.argsSummary = headerSummary;
			}
			const outputSummary = semanticOutputSummary(toolName, semantic, output);
			if (outputSummary) {
				part.outputPreview = outputSummary;
			}
		}

		if (part.startTime) {
			const elapsed = Date.now() - part.startTime;
			if (elapsed >= 1000) {
				part.duration = `${(elapsed / 1000).toFixed(1)}s`;
			} else {
				part.duration = `${elapsed}ms`;
			}
		}

		this.scrollThreadToBottom();
	},
};
