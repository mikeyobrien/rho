import { parseUsageTotals } from "./rendering-and-usage.js";

function cloneJson(value) {
	if (value == null || typeof value !== "object") {
		return value;
	}
	if (Array.isArray(value)) {
		return value.map((item) => cloneJson(item));
	}
	const clone = {};
	for (const [key, item] of Object.entries(value)) {
		clone[key] = cloneJson(item);
	}
	return clone;
}

function mergeUsage(left, right) {
	if (!left && !right) {
		return undefined;
	}
	if (!left) {
		return cloneJson(right);
	}
	if (!right) {
		return cloneJson(left);
	}

	const a = parseUsageTotals(left);
	const b = parseUsageTotals(right);
	const merged = {
		input: a.input + b.input,
		output: a.output + b.output,
		cacheRead: a.cacheRead + b.cacheRead,
		cacheWrite: a.cacheWrite + b.cacheWrite,
		totalTokens: a.total + b.total,
	};

	const cost = (a.cost ?? 0) + (b.cost ?? 0);
	if (a.cost != null || b.cost != null) {
		merged.cost = { total: cost };
	}

	for (const key of [
		"contextWindow",
		"context_window",
		"maxContextTokens",
		"contextTokens",
		"context_tokens",
		"inputWithCache",
		"percent",
		"contextPercent",
		"context_percent",
	]) {
		if (right?.[key] != null) {
			merged[key] = right[key];
		} else if (left?.[key] != null) {
			merged[key] = left[key];
		}
	}

	return merged;
}

function normalizeAssistantContent(content) {
	if (Array.isArray(content)) {
		return cloneJson(content);
	}
	if (content == null || content === "") {
		return [];
	}
	if (typeof content === "string") {
		return [{ type: "text", text: content }];
	}
	return [cloneJson(content)];
}

function cloneMessage(message) {
	return cloneJson(message);
}

function mergeAssistantMessages(existingMessage, nextMessage, options = {}) {
	const existing =
		existingMessage && typeof existingMessage === "object"
			? cloneMessage(existingMessage)
			: null;
	const next =
		nextMessage && typeof nextMessage === "object"
			? cloneMessage(nextMessage)
			: null;
	if (!next) {
		return existing;
	}

	const merged = existing ?? {
		role: "assistant",
		content: [],
		timestamp: next.timestamp,
		id: options.id ?? next.id ?? "",
	};
	merged.id = options.id ?? merged.id ?? next.id ?? "";
	merged.role = "assistant";
	merged.timestamp = merged.timestamp ?? next.timestamp;
	merged.content = [
		...normalizeAssistantContent(merged.content),
		...normalizeAssistantContent(next.content),
	];
	merged.usage = mergeUsage(merged.usage, next.usage);
	merged.api = next.api ?? merged.api;
	merged.provider = next.provider ?? merged.provider;
	merged.model = next.model ?? merged.model;
	merged.stopReason = next.stopReason ?? merged.stopReason;
	merged.errorMessage = next.errorMessage ?? merged.errorMessage;
	return merged;
}

function toolCallMatches(left, right) {
	if (!left || !right) {
		return false;
	}
	if (left.toolCallId && right.toolCallId) {
		return left.toolCallId === right.toolCallId;
	}
	return left.name && right.name && left.name === right.name;
}

function copyToolCallDisplayState(sourceMessage, targetMessage) {
	if (!sourceMessage || !targetMessage) {
		return;
	}
	const sourceToolParts = Array.isArray(sourceMessage.parts)
		? sourceMessage.parts.filter((part) => part.type === "tool_call")
		: [];
	if (sourceToolParts.length === 0 || !Array.isArray(targetMessage.parts)) {
		return;
	}

	const usedIndexes = new Set();
	for (const part of targetMessage.parts) {
		if (part.type !== "tool_call") {
			continue;
		}
		const matchIndex = sourceToolParts.findIndex(
			(candidate, index) =>
				!usedIndexes.has(index) && toolCallMatches(candidate, part),
		);
		if (matchIndex < 0) {
			continue;
		}
		usedIndexes.add(matchIndex);
		const source = sourceToolParts[matchIndex];
		for (const key of [
			"output",
			"outputPreview",
			"status",
			"duration",
			"semantic",
			"argsSummary",
			"diffInfo",
			"isFileEdit",
		]) {
			if (source[key] != null && source[key] !== "") {
				part[key] = source[key];
			}
		}
	}
}

function extractToolResultText(message) {
	if (typeof message?.content === "string") {
		return message.content;
	}
	if (Array.isArray(message?.content)) {
		return message.content
			.map((part) => {
				if (!part || typeof part !== "object") {
					return "";
				}
				if (part.type === "text") {
					return String(part.text ?? "");
				}
				return String(part.output ?? "");
			})
			.filter(Boolean)
			.join("\n");
	}
	return "";
}

function mergeToolResultsIntoSessionMessages(messages) {
	const mergedMessages = [];
	for (const rawMessage of Array.isArray(messages) ? messages : []) {
		const message = cloneMessage(rawMessage);
		const role = String(message?.role ?? "");
		if (role !== "toolResult" && role !== "tool_result" && role !== "tool") {
			mergedMessages.push(message);
			continue;
		}

		const toolCallId = String(message.toolCallId ?? message.tool_use_id ?? "");
		const toolName = String(message.toolName ?? message.tool_name ?? "");
		const resultText = extractToolResultText(message);
		for (let index = mergedMessages.length - 1; index >= 0; index--) {
			const candidate = mergedMessages[index];
			if (
				candidate?.role !== "assistant" ||
				!Array.isArray(candidate.content)
			) {
				continue;
			}
			const toolCall =
				candidate.content.find(
					(part) =>
						(part.type === "toolCall" ||
							part.type === "tool_call" ||
							part.type === "tool_use") &&
						!part.output &&
						(toolCallId
							? String(part.id ?? part.tool_use_id ?? "") === toolCallId
							: toolName
								? String(part.name ?? part.tool_name ?? "") === toolName
								: true),
				) ??
				candidate.content.find(
					(part) =>
						(part.type === "toolCall" ||
							part.type === "tool_call" ||
							part.type === "tool_use") &&
						!part.output,
				);
			if (!toolCall) {
				continue;
			}
			toolCall.output = resultText;
			break;
		}
	}
	return mergedMessages;
}

function groupSessionMessagesIntoTurns(messages) {
	const grouped = [];
	for (const message of mergeToolResultsIntoSessionMessages(messages)) {
		if (message?.role !== "assistant") {
			grouped.push(message);
			continue;
		}
		const previous = grouped[grouped.length - 1];
		if (previous?.role === "assistant") {
			grouped[grouped.length - 1] = mergeAssistantMessages(previous, message, {
				id: previous.id,
			});
			continue;
		}
		grouped.push(mergeAssistantMessages(null, message));
	}
	return grouped;
}

export {
	copyToolCallDisplayState,
	groupSessionMessagesIntoTurns,
	mergeAssistantMessages,
};
