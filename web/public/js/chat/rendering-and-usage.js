import {
	clampString,
	generateOutputPreview,
	parseToolSemantic,
	safeString,
	semanticHeaderSummary,
} from "./constants-and-primitives.js";
import {
	MODEL_CONTEXT_WINDOWS,
	formatModel,
	isFileEditTool,
	normalizeParts,
	parseToolOutput,
	semanticOutputSummary,
} from "./tool-semantics.js";

function guessContextWindow(modelStr) {
	if (!modelStr) return null;
	const lower = modelStr.toLowerCase();
	for (const [key, size] of Object.entries(MODEL_CONTEXT_WINDOWS)) {
		if (lower.includes(key)) return size;
	}
	// Fallback heuristics
	if (lower.includes("claude")) return 200000;
	if (lower.includes("gpt-5") || lower.includes("codex")) return 272000;
	if (lower.includes("gpt-4")) return 128000;
	if (lower.includes("gemini")) return 1048576;
	return null;
}

function toFiniteNumber(value) {
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : null;
}

function parseUsageTotals(usage) {
	if (!usage || typeof usage !== "object") {
		return {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: 0,
			cost: null,
		};
	}

	const usageObj = usage;
	const input =
		toFiniteNumber(
			usageObj.input ??
				usageObj.promptTokens ??
				usageObj.prompt_tokens ??
				usageObj.inputTokens ??
				usageObj.input_tokens,
		) ?? 0;
	const output =
		toFiniteNumber(
			usageObj.output ??
				usageObj.completionTokens ??
				usageObj.completion_tokens ??
				usageObj.outputTokens ??
				usageObj.output_tokens,
		) ?? 0;
	const cacheRead =
		toFiniteNumber(
			usageObj.cacheRead ??
				usageObj.cache_read ??
				usageObj.cacheReadTokens ??
				usageObj.cache_read_input_tokens,
		) ?? 0;
	const cacheWrite =
		toFiniteNumber(
			usageObj.cacheWrite ??
				usageObj.cache_write ??
				usageObj.cacheCreation ??
				usageObj.cacheCreationInputTokens ??
				usageObj.cache_creation_input_tokens,
		) ?? 0;
	const total =
		toFiniteNumber(
			usageObj.totalTokens ??
				usageObj.total ??
				usageObj.total_tokens ??
				usageObj.tokens,
		) ?? input + output + cacheRead + cacheWrite;

	const costObj =
		usageObj.cost && typeof usageObj.cost === "object" ? usageObj.cost : null;
	let cost = toFiniteNumber(
		costObj?.total ??
			usageObj.costTotal ??
			usageObj.totalCost ??
			usageObj.usd ??
			usageObj.cost,
	);
	if (cost == null && costObj) {
		const byPart =
			(toFiniteNumber(costObj.input) ?? 0) +
			(toFiniteNumber(costObj.output) ?? 0) +
			(toFiniteNumber(costObj.cacheRead ?? costObj.cache_read) ?? 0) +
			(toFiniteNumber(costObj.cacheWrite ?? costObj.cache_write) ?? 0);
		if (byPart > 0) {
			cost = byPart;
		}
	}

	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		total,
		cost,
	};
}

function formatUsage(usage, model) {
	if (!usage && !model) {
		return { desktop: "", mobile: "" };
	}

	const usageObj = usage ?? {};
	const usageTotals = parseUsageTotals(usageObj);
	const input = usageTotals.input;
	const output = usageTotals.output;
	const totalTokens = usageTotals.total;
	const cacheRead = usageTotals.cacheRead;
	const cacheWrite = usageTotals.cacheWrite;
	const cost = usageTotals.cost;

	// Compute context usage percentage
	const usageContextWindow = Number(
		usageObj.contextWindow ??
			usageObj.context_window ??
			usageObj.maxContextTokens ??
			0,
	);
	const guessedContextWindow = guessContextWindow(model);
	const contextWindow = usageContextWindow || guessedContextWindow;
	const contextTokens =
		Number(
			usageObj.contextTokens ??
				usageObj.context_tokens ??
				usageObj.inputWithCache,
		) ||
		input + cacheRead ||
		totalTokens;
	const usagePercent = Number(
		usageObj.percent ?? usageObj.contextPercent ?? usageObj.context_percent,
	);
	let pct = Number.isFinite(usagePercent) ? Math.round(usagePercent) : null;
	if (pct == null && contextWindow && contextTokens) {
		pct = Math.round((contextTokens / contextWindow) * 100);
	}

	// Desktop: model, ctx %, tokens, cost, cache
	const desktopParts = [];
	if (model) {
		desktopParts.push(`model: ${model}`);
	}
	if (pct != null) {
		desktopParts.push(`ctx: ${pct}%`);
	}
	if (totalTokens) {
		desktopParts.push(`tokens: ${totalTokens}`);
	} else if (input || output) {
		desktopParts.push(`tokens: ${input}/${output}`);
	}
	if (cost != null && cost !== "" && Number.isFinite(Number(cost))) {
		desktopParts.push(`cost: $${Number(cost).toFixed(4)}`);
	}
	if (cacheRead || cacheWrite) {
		desktopParts.push(`cache: ${cacheRead}/${cacheWrite}`);
	}

	// Mobile: model + percentage only
	const mobileParts = [];
	if (model) {
		mobileParts.push(model);
	}
	if (pct != null) {
		mobileParts.push(`${pct}% ctx`);
	}
	if (cost != null && cost !== "" && Number.isFinite(Number(cost))) {
		mobileParts.push(`$${Number(cost).toFixed(4)}`);
	}

	return {
		desktop: desktopParts.join(" · "),
		mobile: mobileParts.join(" · "),
	};
}

function formatTimestamp(value) {
	if (!value) {
		return "";
	}
	const parsed = new Date(value);
	if (Number.isNaN(parsed.getTime())) {
		return String(value);
	}
	return parsed.toLocaleString();
}

function _formatTimestampShort(value) {
	if (!value) {
		return "";
	}
	const parsed = new Date(value);
	if (Number.isNaN(parsed.getTime())) {
		return String(value);
	}
	const now = new Date();
	const diffMs = now - parsed;
	const diffMin = Math.floor(diffMs / 60000);
	const diffHr = Math.floor(diffMs / 3600000);
	const diffDay = Math.floor(diffMs / 86400000);
	if (diffMin < 1) return "just now";
	if (diffMin < 60) return `${diffMin}m ago`;
	if (diffHr < 24) return `${diffHr}h ago`;
	if (diffDay < 7) return `${diffDay}d ago`;
	return parsed.toLocaleDateString(undefined, {
		month: "short",
		day: "numeric",
	});
}

function renderMarkdown(text) {
	if (!text) {
		return "";
	}
	try {
		return marked.parse(text);
	} catch {
		return text.replace(
			/[&<>"']/g,
			(char) =>
				({
					"&": "&amp;",
					"<": "&lt;",
					">": "&gt;",
					'"': "&quot;",
					"'": "&#39;",
				})[char],
		);
	}
}

function highlightCodeBlocks(root) {
	if (!root || typeof hljs === "undefined") {
		return;
	}
	for (const block of root.querySelectorAll("pre code")) {
		hljs.highlightElement(block);
	}
}

function normalizeMessage(message, isLazy = false) {
	const role = message.role ?? "assistant";
	const parts = normalizeParts(message.content ?? message);

	const normalizedParts = parts.map((part, index) => {
		if (part.type === "text") {
			const text = String(part.text ?? "");
			const shouldRenderMarkdown = role === "assistant" || role === "system";
			return {
				...part,
				key: `${message.id}-text-${index}`,
				render: shouldRenderMarkdown ? "html" : "text",
				rawContent: text,
				content: shouldRenderMarkdown && !isLazy ? renderMarkdown(text) : text,
				isRendered: !isLazy,
			};
		}
		if (part.type === "thinking") {
			const thinkingText = String(part.text ?? "");
			return {
				...part,
				key: `${message.id}-thinking-${index}`,
				rawContent: thinkingText,
				content: !isLazy ? renderMarkdown(thinkingText) : thinkingText,
				preview: generateOutputPreview(thinkingText, 100),
				isRendered: !isLazy,
			};
		}
		if (part.type === "tool_call") {
			const args =
				typeof part.args === "string" ? part.args : safeString(part.args ?? "");
			const output =
				typeof part.output === "string"
					? part.output
					: safeString(part.output ?? "");
			const toolName = part.name ?? "";
			const parsedOutput = parseToolOutput(output, toolName);
			const semantic =
				part.semantic ?? parseToolSemantic(toolName, args, output);
			const headerSummary = semanticHeaderSummary(toolName, semantic);
			const outputSummaryText = semanticOutputSummary(
				toolName,
				semantic,
				output,
			);
			return {
				...part,
				key: `${message.id}-tool-${index}`,
				args,
				argsSummary:
					headerSummary || part.argsSummary || clampString(args, 120),
				output,
				outputPreview:
					outputSummaryText ||
					part.outputPreview ||
					generateOutputPreview(output),
				status: part.status ?? "done",
				duration: part.duration ?? "",
				isFileEdit: isFileEditTool(toolName),
				diffInfo: parsedOutput,
				semantic,
			};
		}
		if (part.type === "bash") {
			return {
				...part,
				key: `${message.id}-bash-${index}`,
				command: part.command ?? "",
				output: part.output ?? "",
			};
		}
		if (
			part.type === "compaction" ||
			part.type === "summary" ||
			part.type === "retry"
		) {
			return {
				...part,
				key: `${message.id}-summary-${index}`,
			};
		}
		if (part.type === "error") {
			return {
				...part,
				key: `${message.id}-error-${index}`,
			};
		}
		return {
			...part,
			key: `${message.id}-part-${index}`,
		};
	});

	return {
		id: message.id,
		role,
		roleLabel: role === "assistant" ? "assistant" : role,
		timestamp: formatTimestamp(message.timestamp ?? ""),
		parts: normalizedParts,
		usageData:
			role === "assistant"
				? formatUsage(message.usage, formatModel(message.model))
				: { desktop: "", mobile: "" },
		canFork: role === "user",
	};
}

function buildWsUrl() {
	const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
	return `${protocol}//${window.location.host}/ws`;
}

async function fetchJson(url) {
	const response = await fetch(url);
	if (!response.ok) {
		const error = await response.json().catch(() => ({}));
		throw new Error(error.error ?? `Request failed (${response.status})`);
	}
	return response.json();
}

async function postJson(url, payload) {
	const response = await fetch(url, {
		method: "POST",
		headers: {
			"content-type": "application/json",
		},
		body: JSON.stringify(payload ?? {}),
	});

	const data = await response.json().catch(() => ({}));
	if (!response.ok) {
		throw new Error(data.error ?? `Request failed (${response.status})`);
	}
	return data;
}

function toIsoTimestamp(value) {
	if (typeof value === "number") {
		return new Date(value).toISOString();
	}
	if (typeof value === "string") {
		const parsed = new Date(value);
		if (!Number.isNaN(parsed.getTime())) {
			return parsed.toISOString();
		}
	}
	return new Date().toISOString();
}

function findToolCallInMessage(message, contentIndex) {
	const content = message?.content;
	if (!Array.isArray(content)) {
		return null;
	}
	const block = content[Number(contentIndex)];
	if (block && typeof block === "object" && block.type === "toolCall") {
		return block;
	}
	return null;
}

function extractToolOutput(result) {
	if (!result) {
		return "";
	}
	if (typeof result === "string") {
		return result;
	}

	const textFromContent = Array.isArray(result.content)
		? result.content
				.map((item) => {
					if (!item || typeof item !== "object") {
						return "";
					}
					if (item.type === "text") {
						return String(item.text ?? "");
					}
					return safeString(item);
				})
				.filter(Boolean)
				.join("\n")
		: "";

	if (textFromContent) {
		return textFromContent;
	}

	if (result.details != null) {
		return safeString(result.details);
	}

	return safeString(result);
}

const THINKING_LEVELS_BASE = ["off", "minimal", "low", "medium", "high"];

function normalizeThinkingLevel(level) {
	const normalized = String(level ?? "")
		.trim()
		.toLowerCase();
	if (normalized === "none") {
		return "off";
	}
	if (normalized === "xhigh" || THINKING_LEVELS_BASE.includes(normalized)) {
		return normalized;
	}
	return "medium";
}

export {
	guessContextWindow,
	toFiniteNumber,
	parseUsageTotals,
	formatUsage,
	formatTimestamp,
	_formatTimestampShort,
	renderMarkdown,
	highlightCodeBlocks,
	normalizeMessage,
	buildWsUrl,
	fetchJson,
	postJson,
	toIsoTimestamp,
	findToolCallInMessage,
	extractToolOutput,
	THINKING_LEVELS_BASE,
	normalizeThinkingLevel,
};
