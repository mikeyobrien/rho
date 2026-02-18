const CHAT_REFRESH_INTERVAL = 15000;

const slashContract = globalThis.__rhoSlashContract ?? {
	INTERACTIVE_ONLY_SLASH_COMMANDS: new Set(["settings", "hotkeys"]),
	parseSlashInput: () => ({
		kind: "not_slash",
		isSlash: false,
		commandName: "",
	}),
	normalizeCommandsPayload: () => [],
	buildCommandIndex: () => new Map(),
	classifySlashCommand: () => ({
		kind: "not_slash",
		isSlash: false,
		commandName: "",
	}),
	resolvePromptOptions: () => ({}),
	formatUnsupportedMessage: () =>
		"Slash command is not available in this RPC session.",
	formatPromptFailure: (_inputMessage, rawError) =>
		String(rawError || "RPC prompt failed"),
};

function safeString(value) {
	if (value == null) {
		return "";
	}
	if (typeof value === "string") {
		return value;
	}
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}

function clampString(value, max) {
	if (!value) {
		return "";
	}
	if (value.length <= max) {
		return value;
	}
	return `${value.slice(0, max)}...`;
}

function generateOutputPreview(output, maxLen = 80) {
	if (!output) return "";
	const oneLine = output.replace(/\n/g, " ").replace(/\s+/g, " ").trim();
	return oneLine.length > maxLen
		? `${oneLine.substring(0, maxLen)}...`
		: oneLine;
}

// ─── Semantic Tool Parser Infrastructure ───
// Registry of native pi tools with argument/output parsers.
// Each parser receives (parsedArgs, outputString) and returns structured data.

function safeJsonParse(str) {
	if (!str) return null;
	try {
		return typeof str === "string" ? JSON.parse(str) : str;
	} catch {
		return null;
	}
}

function extractFilename(filePath) {
	if (!filePath) return "";
	return filePath.split("/").pop() || filePath;
}

function fileExtension(filePath) {
	if (!filePath) return "";
	const name = extractFilename(filePath);
	const dot = name.lastIndexOf(".");
	return dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
}

const EXT_TO_LANG = {
	ts: "typescript",
	tsx: "typescript",
	js: "javascript",
	jsx: "javascript",
	css: "css",
	html: "html",
	htm: "html",
	md: "markdown",
	json: "json",
	py: "python",
	sh: "bash",
	bash: "bash",
	zsh: "bash",
	fish: "fish",
	yml: "yaml",
	yaml: "yaml",
	toml: "toml",
	rs: "rust",
	go: "go",
	rb: "ruby",
	java: "java",
	c: "c",
	cpp: "cpp",
	h: "c",
	hpp: "cpp",
	sql: "sql",
	xml: "xml",
	svg: "xml",
	nix: "nix",
};

function langFromPath(filePath) {
	return EXT_TO_LANG[fileExtension(filePath)] || "";
}

const TOOL_REGISTRY = {
	edit(args, output) {
		const a = safeJsonParse(args) || {};
		const path = a.path || "";
		const oldText = a.oldText || "";
		const newText = a.newText || "";
		const oldLines = oldText ? oldText.split("\n").length : 0;
		const newLines = newText ? newText.split("\n").length : 0;
		const success =
			!output || /successfully/i.test(output) || /replaced/i.test(output);
		return {
			tool: "edit",
			path,
			filename: extractFilename(path),
			lang: langFromPath(path),
			hasOldNew: Boolean(oldText && newText),
			oldText,
			newText,
			linesRemoved: oldLines,
			linesAdded: newLines,
			success,
		};
	},

	write(args, output) {
		const a = safeJsonParse(args) || {};
		const path = a.path || "";
		const success =
			!output ||
			/successfully/i.test(output) ||
			/wrote/i.test(output) ||
			/created/i.test(output);
		return {
			tool: "write",
			path,
			filename: extractFilename(path),
			lang: langFromPath(path),
			content: a.content || "",
			success,
		};
	},

	read(args, output) {
		const a = safeJsonParse(args) || {};
		const path = a.path || "";
		const offset = a.offset != null ? Number(a.offset) : null;
		const limit = a.limit != null ? Number(a.limit) : null;
		const lines = output ? output.split("\n") : [];
		return {
			tool: "read",
			path,
			filename: extractFilename(path),
			lang: langFromPath(path),
			offset,
			limit,
			fileExtension: fileExtension(path),
			content: output || "",
			lineCount: lines.length,
		};
	},

	bash(args, output) {
		const a = safeJsonParse(args) || {};
		const command = a.command || "";
		const timeout = a.timeout != null ? Number(a.timeout) : null;
		const lines = output ? output.split("\n") : [];
		const isError =
			/error|FAIL|fatal|panic|exception/i.test(output || "") &&
			!/0 error/i.test(output || "");
		return {
			tool: "bash",
			command,
			timeout,
			output: output || "",
			lineCount: lines.length,
			isError,
		};
	},

	brain(args, output) {
		const a = safeJsonParse(args) || {};
		const action = a.action || "";
		const type = a.type || null;
		const id = a.id || null;
		const parts = [action, type].filter(Boolean);
		return {
			tool: "brain",
			action,
			type,
			id,
			query: a.query || null,
			filter: a.filter || null,
			summary: parts.join(" ") || "brain",
			rawOutput: output || "",
		};
	},

	vault(args, output) {
		const a = safeJsonParse(args) || {};
		const action = a.action || "";
		const slug = a.slug || null;
		const query = a.query || null;
		return {
			tool: "vault",
			action,
			slug,
			query,
			type: a.type || null,
			summary: query
				? `${action}: "${clampString(query, 40)}"`
				: action || "vault",
			rawOutput: output || "",
		};
	},

	vault_search(args, output) {
		const a = safeJsonParse(args) || {};
		const query = a.query || "";
		return {
			tool: "vault",
			action: "search",
			slug: null,
			query,
			type: a.type || null,
			summary: query ? `search: "${clampString(query, 40)}"` : "search",
			rawOutput: output || "",
		};
	},

	email(args, output) {
		const a = safeJsonParse(args) || {};
		const action = a.action || "";
		const to = a.to || null;
		const subject = a.subject || null;
		let summary = action;
		if (action === "send" && to) {
			summary = `send → ${to}`;
		} else if (subject) {
			summary = `${action}: ${clampString(subject, 40)}`;
		}
		return {
			tool: "email",
			action,
			to,
			subject,
			body: a.body || null,
			summary,
			rawOutput: output || "",
		};
	},
};

// Aliases for alternate tool names
TOOL_REGISTRY["multi-edit"] = TOOL_REGISTRY.edit;
TOOL_REGISTRY.multi_edit = TOOL_REGISTRY.edit;
TOOL_REGISTRY.str_replace_browser = TOOL_REGISTRY.edit;
TOOL_REGISTRY.Read = TOOL_REGISTRY.read;
TOOL_REGISTRY.Edit = TOOL_REGISTRY.edit;
TOOL_REGISTRY.Write = TOOL_REGISTRY.write;
TOOL_REGISTRY.Bash = TOOL_REGISTRY.bash;

function parseToolSemantic(name, argsString, outputString) {
	const parser = TOOL_REGISTRY[name];
	if (!parser) return null;
	try {
		return parser(argsString, outputString);
	} catch {
		return null;
	}
}

function semanticHeaderSummary(name, semantic) {
	if (!semantic) return "";
	switch (semantic.tool) {
		case "edit":
			return semantic.path || semantic.filename || name;
		case "write":
			return semantic.path || semantic.filename || name;
		case "read": {
			let s = semantic.path || semantic.filename || name;
			if (semantic.offset != null) {
				const end =
					semantic.limit != null ? semantic.offset + semantic.limit - 1 : "";
				s += `:${semantic.offset}${end ? `-${end}` : ""}`;
			}
			return s;
		}
		case "bash":
			return semantic.command ? clampString(semantic.command, 80) : name;
		case "brain":
			return semantic.summary || name;
		case "vault":
			return semantic.summary || name;
		case "email":
			return semantic.summary || name;
		default:
			return "";
	}
}

function semanticOutputSummary(_name, semantic, output) {
	if (!semantic) return generateOutputPreview(output);
	switch (semantic.tool) {
		case "edit":
			if (semantic.success && semantic.hasOldNew) {
				return `+${semantic.linesAdded} | −${semantic.linesRemoved}`;
			}
			return semantic.success ? "✓ Applied" : generateOutputPreview(output);
		case "write":
			return semantic.success ? "✓ Written" : generateOutputPreview(output);
		case "read":
			return semantic.lineCount
				? `${semantic.lineCount} lines`
				: generateOutputPreview(output);
		case "bash":
			return generateOutputPreview(output);
		case "brain":
		case "vault":
		case "email":
			return generateOutputPreview(output);
		default:
			return generateOutputPreview(output);
	}
}

// Legacy compat wrappers (used by existing diffInfo code path — will be removed when semantic views replace it)
function isFileEditTool(toolName) {
	if (!toolName) return false;
	const name = toolName.toLowerCase();
	return (
		name === "edit" ||
		name === "write" ||
		name === "str_replace_browser" ||
		name === "multi-edit" ||
		name === "multi_edit"
	);
}

function parseToolOutput(output, toolName) {
	if (!output || !isFileEditTool(toolName)) return null;
	const result = {
		hasDiff: false,
		filePath: null,
		linesAdded: 0,
		linesRemoved: 0,
		diffLines: [],
	};
	const pathMatch = output.match(/([~/]?[\w\-./]+\.[a-zA-Z0-9]+)/);
	if (pathMatch) result.filePath = pathMatch[1];
	if (result.filePath) return result;
	return null;
}

function extractText(content) {
	if (content == null) {
		return "";
	}
	if (typeof content === "string") {
		return content;
	}
	if (Array.isArray(content)) {
		return content
			.map((item) => {
				if (typeof item === "string") {
					return item;
				}
				if (item && typeof item === "object" && "text" in item) {
					return String(item.text ?? "");
				}
				return "";
			})
			.filter(Boolean)
			.join(" ");
	}
	if (typeof content === "object" && "text" in content) {
		return String(content.text ?? "");
	}
	return safeString(content);
}

function normalizeToolCall(item) {
	const name =
		item.name ??
		item.tool_name ??
		item.toolName ??
		item.function?.name ??
		item.functionName ??
		"tool";
	const args =
		item.arguments ??
		item.args ??
		item.input ??
		item.function?.arguments ??
		item.parameters ??
		"";
	const output =
		item.output ??
		item.result ??
		item.response ??
		item.tool_output ??
		item.toolResult ??
		"";

	const argsText = typeof args === "string" ? args : safeString(args);
	const outputText = typeof output === "string" ? output : safeString(output);

	const semantic = parseToolSemantic(name, argsText, outputText);
	const headerSummary = semanticHeaderSummary(name, semantic);
	const outputSummary = semanticOutputSummary(name, semantic, outputText);

	return {
		type: "tool_call",
		name,
		toolCallId: item.id ?? item.tool_use_id ?? item.toolUseId ?? "",
		args: argsText,
		argsSummary:
			headerSummary || clampString(argsText.replace(/\s+/g, " ").trim(), 120),
		output: outputText,
		outputPreview: outputSummary || generateOutputPreview(outputText),
		status: item.isError ? "error" : (item.status ?? "done"),
		duration: item.duration ?? "",
		semantic,
	};
}

function normalizeContentItem(item) {
	if (item == null) {
		return [];
	}
	if (typeof item === "string") {
		return [{ type: "text", text: item }];
	}
	if (typeof item !== "object") {
		return [{ type: "text", text: String(item) }];
	}

	const itemType = item.type;

	if (
		itemType === "thinking" ||
		itemType === "reasoning" ||
		itemType === "analysis"
	) {
		return [
			{
				type: "thinking",
				text: item.thinking ?? item.text ?? item.content ?? item.thought ?? "",
			},
		];
	}

	if (itemType === "toolCall") {
		const argsText = safeString(item.arguments ?? {});
		const outputText = item.output ?? "";
		return [
			{
				type: "tool_call",
				name: item.name ?? "tool",
				args: argsText,
				argsSummary: clampString(argsText.replace(/\s+/g, " ").trim(), 120),
				output: outputText,
				outputPreview: generateOutputPreview(outputText),
				toolCallId: item.id ?? "",
				status: outputText ? "done" : "running",
				duration: "",
			},
		];
	}

	if (
		itemType === "tool_call" ||
		itemType === "tool_use" ||
		itemType === "tool"
	) {
		return [normalizeToolCall(item)];
	}

	if (
		itemType === "tool_result" ||
		itemType === "tool_output" ||
		itemType === "tool_response"
	) {
		// Tool results are merged into tool_call parts - return empty to skip standalone rendering
		// The merging happens in normalizeParts after all parts are collected
		return [
			{
				type: "tool_result",
				name: item.name ?? item.tool_name ?? "tool",
				toolUseId: item.tool_use_id ?? item.toolUseId ?? "",
				output:
					typeof item.output === "string"
						? item.output
						: safeString(item.output ?? item.result ?? item),
			},
		];
	}

	if (itemType === "bash" || itemType === "shell" || itemType === "command") {
		return [
			{
				type: "bash",
				command: item.command ?? item.cmd ?? item.text ?? "",
				output: item.output ?? item.result ?? "",
			},
		];
	}

	if (itemType === "error") {
		return [
			{ type: "error", text: item.message ?? item.error ?? safeString(item) },
		];
	}

	if (
		itemType === "text" ||
		itemType === "input_text" ||
		itemType === "output_text" ||
		itemType === "markdown"
	) {
		return [{ type: "text", text: item.text ?? item.content ?? "" }];
	}

	if (itemType === "image") {
		// Reconstruct dataUrl from base64 data + mimeType (stored in session JSONL)
		const mimeType = item.mimeType ?? item.media_type ?? "image/png";
		const data = item.data ?? item.source?.data ?? "";
		if (data) {
			return [{ type: "image", dataUrl: `data:${mimeType};base64,${data}` }];
		}
		// Already has a dataUrl (live rendering)
		if (item.dataUrl) {
			return [{ type: "image", dataUrl: item.dataUrl }];
		}
		return [];
	}

	if ("tool_calls" in item && Array.isArray(item.tool_calls)) {
		return item.tool_calls.map(normalizeToolCall);
	}

	if ("tool" in item || "toolName" in item || "function" in item) {
		return [normalizeToolCall(item)];
	}

	if ("thinking" in item) {
		return [{ type: "thinking", text: item.thinking }];
	}

	if ("command" in item || "cmd" in item) {
		return [
			{
				type: "bash",
				command: item.command ?? item.cmd ?? "",
				output: item.output ?? item.result ?? "",
			},
		];
	}

	if ("error" in item) {
		return [{ type: "error", text: item.error ?? safeString(item) }];
	}

	if ("text" in item) {
		return [{ type: "text", text: item.text ?? "" }];
	}

	return [{ type: "text", text: safeString(item) }];
}

function normalizeParts(content) {
	if (content == null) {
		return [];
	}
	if (typeof content === "string") {
		return [{ type: "text", text: content }];
	}
	if (Array.isArray(content)) {
		const rawParts = content.flatMap((item) => normalizeContentItem(item));
		// Merge tool_result into matching tool_call parts
		const toolCalls = rawParts.filter((p) => p.type === "tool_call");
		const toolResults = rawParts.filter((p) => p.type === "tool_result");
		const otherParts = rawParts.filter(
			(p) => p.type !== "tool_call" && p.type !== "tool_result",
		);

		// Match results to calls by toolCallId/toolUseId or by name+position
		for (const result of toolResults) {
			let matched = false;
			// Try to match by ID first
			if (result.toolUseId) {
				const call = toolCalls.find(
					(c) => c.toolCallId === result.toolUseId && !c.output,
				);
				if (call) {
					call.output = result.output;
					call.outputPreview = generateOutputPreview(result.output);
					call.status = "done";
					matched = true;
				}
			}
			// Fallback: match by name (first unmatched call with same name)
			if (!matched && result.name) {
				const call = toolCalls.find((c) => c.name === result.name && !c.output);
				if (call) {
					call.output = result.output;
					call.outputPreview = generateOutputPreview(result.output);
					call.status = "done";
					matched = true;
				}
			}
			// If still not matched, match to any call without output
			if (!matched) {
				const call = toolCalls.find((c) => !c.output);
				if (call) {
					call.output = result.output;
					call.outputPreview = generateOutputPreview(result.output);
					call.status = "done";
				}
			}
		}
		// Mark any remaining tool_calls without results as "done" (historical data, not running)
		for (const call of toolCalls) {
			if (call.status === "running") {
				call.status = "done";
			}
		}
		// Return tool_calls and other parts, excluding tool_result (merged into calls)
		return [...toolCalls, ...otherParts];
	}

	if (typeof content === "object") {
		const contentType = content.type;
		if (contentType === "compaction") {
			return [
				{
					type: "compaction",
					summary: content.summary ?? "Context compacted",
				},
			];
		}

		if (contentType === "branch_summary") {
			return [
				{
					type: "summary",
					summary: content.summary ?? "Branch summary",
				},
			];
		}

		if (
			contentType === "tool_call" ||
			contentType === "tool_use" ||
			contentType === "tool"
		) {
			return [normalizeToolCall(content)];
		}

		if (contentType === "tool_result" || contentType === "tool_output") {
			return [
				{
					type: "tool_result",
					name: content.name ?? content.tool_name ?? "tool",
					output:
						typeof content.output === "string"
							? content.output
							: safeString(content.output ?? content.result ?? content),
				},
			];
		}

		if (
			contentType === "bash" ||
			contentType === "shell" ||
			contentType === "command"
		) {
			return [
				{
					type: "bash",
					command: content.command ?? content.cmd ?? "",
					output: content.output ?? content.result ?? "",
				},
			];
		}

		if (contentType === "error") {
			return [
				{
					type: "error",
					text: content.message ?? content.error ?? safeString(content),
				},
			];
		}

		if ("tool_calls" in content && Array.isArray(content.tool_calls)) {
			return content.tool_calls.map(normalizeToolCall);
		}

		if ("text" in content) {
			return [{ type: "text", text: content.text ?? "" }];
		}

		if ("thinking" in content) {
			return [{ type: "thinking", text: content.thinking ?? "" }];
		}

		return [{ type: "text", text: safeString(content) }];
	}

	return [{ type: "text", text: safeString(content) }];
}

function formatModel(model) {
	if (!model) {
		return "";
	}
	if (typeof model === "string") {
		return model;
	}
	const provider = model.provider ?? model.vendor ?? "";
	const modelId = model.modelId ?? model.id ?? model.name ?? "";
	if (provider && modelId) {
		return `${provider}/${modelId}`;
	}
	return modelId || provider || safeString(model);
}

// Context window sizes (input tokens) for common models
const MODEL_CONTEXT_WINDOWS = {
	"claude-opus-4": 200000,
	"claude-sonnet-4": 200000,
	"claude-3.5-sonnet": 200000,
	"claude-3-opus": 200000,
	"claude-3-sonnet": 200000,
	"claude-3-haiku": 200000,
	"gpt-4o": 128000,
	"gpt-4o-mini": 128000,
	"gpt-4-turbo": 128000,
	"gpt-4": 8192,
	o1: 200000,
	"o1-mini": 128000,
	"o1-pro": 200000,
	o3: 200000,
	"o3-mini": 200000,
	"o4-mini": 200000,
	"gemini-2.5-pro": 1048576,
	"gemini-2.5-flash": 1048576,
	"gemini-2.0-flash": 1048576,
	"deepseek-r1": 131072,
	"deepseek-v3": 131072,
};

function guessContextWindow(modelStr) {
	if (!modelStr) return null;
	const lower = modelStr.toLowerCase();
	for (const [key, size] of Object.entries(MODEL_CONTEXT_WINDOWS)) {
		if (lower.includes(key)) return size;
	}
	// Fallback heuristics
	if (lower.includes("claude")) return 200000;
	if (lower.includes("gpt-4")) return 128000;
	if (lower.includes("gemini")) return 1048576;
	return null;
}

function formatUsage(usage, model) {
	if (!usage && !model) {
		return { desktop: "", mobile: "" };
	}

	const usageObj = usage ?? {};
	const input = Number(
		usageObj.input ?? usageObj.promptTokens ?? usageObj.inputTokens ?? 0,
	);
	const output = Number(
		usageObj.output ?? usageObj.completionTokens ?? usageObj.outputTokens ?? 0,
	);
	const totalTokens = Number(
		usageObj.totalTokens ??
			usageObj.total ??
			usageObj.total_tokens ??
			usageObj.tokens ??
			(input || output ? input + output : 0),
	);
	const cacheRead = Number(
		usageObj.cacheRead ?? usageObj.cache_read ?? usageObj.cacheReadTokens ?? 0,
	);
	const cacheWrite = Number(
		usageObj.cacheWrite ?? usageObj.cache_write ?? usageObj.cacheCreation ?? 0,
	);
	const cost =
		usageObj.cost?.total ??
		usageObj.costTotal ??
		usageObj.totalCost ??
		usageObj.usd ??
		usageObj.cost ??
		null;

	// Compute context usage percentage
	const contextWindow = guessContextWindow(model);
	const contextTokens = input || totalTokens;
	let pct = null;
	if (contextWindow && contextTokens) {
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
	root.querySelectorAll("pre code").forEach((block) => {
		hljs.highlightElement(block);
	});
}

function normalizeMessage(message, isLazy = false) {
	const role = message.role ?? "assistant";
	const parts = normalizeParts(message.content ?? message);

	const normalizedParts = parts.map((part, index) => {
		if (part.type === "text") {
			const text = String(part.text ?? "");
			const isHtml = role === "assistant";
			return {
				...part,
				key: `${message.id}-text-${index}`,
				render: isHtml ? "html" : "text",
				rawContent: text,
				content: isHtml && !isLazy ? renderMarkdown(text) : text,
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

const THINKING_LEVELS = ["none", "low", "medium", "high"];

// Toast notification levels
const TOAST_LEVELS = {
	info: { color: "var(--cyan)", icon: "ℹ" },
	success: { color: "var(--green)", icon: "✓" },
	warning: { color: "var(--yellow)", icon: "⚠" },
	error: { color: "var(--red)", icon: "✕" },
};

// Default toast duration
const TOAST_DEFAULT_DURATION = 5000;

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

		// Slash autocomplete state
		slashAcVisible: false,
		slashAcItems: [],
		slashAcIndex: 0,
		streamMessageId: "",
		hasEarlierMessages: false,
		allNormalizedMessages: [],
		markdownRenderQueue: new Map(),
		markdownTimeout: null,
		toolCallPartById: new Map(),

		// Sessions panel state (slide-out overlay, hidden by default)
		showSessionsPanel: false,

		// Queued prompts: messages typed during streaming, auto-sent in order on agent_end
		// Each item: { id, text, images: [{ data, mimeType, dataUrl }] }
		promptQueue: [],
		showQueue: true,

		toggleTheme() {
			this.theme = this.theme === "light" ? "dark" : "light";
			document.body.classList.toggle("theme-light", this.theme === "light");
			localStorage.setItem("rho-theme", this.theme);
		},

		// Auto-scroll state
		userScrolledUp: false,
		_programmaticScrollUntil: 0,
		_prevScrollTop: 0,

		// Image attachments
		pendingImages: [],
		isDraggingOver: false,
		dragLeaveTimeout: null,

		// Chat controls state
		availableModels: [],
		thinkingLevels: THINKING_LEVELS,
		currentModel: null,
		currentThinkingLevel: "medium",
		isStreaming: false,
		sessionStats: { tokens: 0, cost: 0 },
		pendingModelChange: null,

		// Extension UI state
		extensionDialog: null,
		extensionWidget: null,
		extensionStatus: "",
		toasts: [],
		toastIdCounter: 0,

		// WebSocket reconnection state
		wsReconnectAttempts: 0,
		wsReconnectTimer: null,
		wsMaxReconnectDelay: 30000,
		wsBaseReconnectDelay: 1000,
		isWsConnected: false,
		showReconnectBanner: false,
		theme: "dark",

		// Idle detection state
		lastActivityTime: Date.now(),
		isIdle: false,
		idleCheckInterval: null,

		// Visibility state
		isPageVisible: true,

		async init() {
			// Load theme preference
			this.theme = localStorage.getItem("rho-theme") || "dark";
			if (this.theme === "light") {
				document.body.classList.add("theme-light");
			}
			marked.setOptions({
				gfm: true,
				breaks: true,
			});
			this.connectWebSocket();
			// Restore session from URL hash
			const hashId = window.location.hash.replace("#", "").trim();
			if (hashId) {
				this.activeSessionId = hashId;
			}
			// Setup idle and visibility detection
			this.setupIdleDetection();
			this.setupVisibilityDetection();
			await this.loadSessions();
			this.startPolling();
			this.setupKeyboardShortcuts();
			this.setupPullToRefresh();
			// Sync hash on back/forward
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
						entries.forEach((entry) => {
							if (!entry.isIntersecting) return;
							const msgEl = entry.target;
							const msgId = msgEl.dataset.messageId;
							if (!msgId) return;

							// Find and render the message
							const msg = this.renderedMessages.find((m) => m.id === msgId);
							if (!msg || !msg.parts) return;

							let modified = false;
							msg.parts.forEach((part) => {
								if (part.isRendered) return;
								if (part.type === "text" || part.type === "thinking") {
									part.content = renderMarkdown(
										part.rawContent || part.content,
									);
									part.isRendered = true;
									modified = true;
								}
							});

							if (modified) {
								this.$nextTick(() => {
									highlightCodeBlocks(msgEl);
								});
							}

							// Stop observing once rendered
							this._lazyObserver?.unobserve(msgEl);
						});
					},
					{ rootMargin: "200px" }, // Pre-render 200px before visible
				);

				// Observe all message elements
				thread.querySelectorAll("[data-message-id]").forEach((el) => {
					this._lazyObserver?.observe(el);
				});
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
			if (prevTop !== undefined && el.scrollTop < prevTop - 10) {
				this.userScrolledUp = true;
			}
		},

		connectWebSocket() {
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
				this.isWsConnected = true;
				this.showReconnectBanner = false;
				this.wsReconnectAttempts = 0;
				this.error = "";

				// Re-establish RPC session after reconnect.
				// The server killed the old session when the previous socket closed,
				// so we need to send switch_session again on the new socket.
				const sessionFile =
					this.activeRpcSessionFile ||
					this.getSessionFile(this.activeSessionId);
				if (sessionFile) {
					this.activeRpcSessionId = "";
					this.startRpcSession(sessionFile);
				}
			});

			ws.addEventListener("message", (event) => {
				this.handleWsMessage(event);
			});

			ws.addEventListener("close", () => {
				if (this.ws === ws) {
					this.ws = null;
					this.isWsConnected = false;
					this.scheduleReconnect();
				}
			});

			ws.addEventListener("error", () => {
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
			this.connectWebSocket();
		},

		sendWs(payload) {
			if (!this.ws) {
				this.error = "WebSocket not connected";
				return false;
			}

			if (this.ws.readyState === WebSocket.CONNECTING) {
				this.ws.addEventListener(
					"open",
					() => {
						this.ws?.send(JSON.stringify(payload));
					},
					{ once: true },
				);
				return true;
			}

			if (this.ws.readyState !== WebSocket.OPEN) {
				this.error = "WebSocket not connected";
				return false;
			}

			this.ws.send(JSON.stringify(payload));
			return true;
		},

		handleWsMessage(event) {
			let payload = null;
			try {
				payload = JSON.parse(event.data);
			} catch {
				return;
			}

			if (!payload || typeof payload !== "object") {
				return;
			}

			if (payload.type === "error") {
				this.error = payload.message ?? "WebSocket error";
				this.isForking = false;
				this.isSendingPrompt = false;
				return;
			}

			if (payload.type === "session_started") {
				this.activeRpcSessionId = payload.sessionId ?? "";
				this.activeRpcSessionFile = payload.sessionFile ?? "";
				this.isForking = false;
				// Fetch initial state and available models
				this.requestState();
				this.requestAvailableModels();
				this.requestSessionStats();
				this.requestSlashCommands(true);
				return;
			}

			if (payload.type !== "rpc_event") {
				return;
			}

			if (!payload.sessionId || payload.sessionId !== this.activeRpcSessionId) {
				return;
			}

			const rpcEvent = payload.event;
			if (!rpcEvent || typeof rpcEvent !== "object") {
				return;
			}

			this.handleRpcEvent(rpcEvent);
		},

		handleRpcEvent(event) {
			if (event.type === "response") {
				if (!event.success) {
					if (
						event.command === "prompt" &&
						this.pendingSlashClassification?.isSlash
					) {
						const rawError =
							event.error ??
							`RPC command failed: ${event.command ?? "unknown"}`;
						this.error = slashContract.formatPromptFailure(
							this.pendingSlashClassification.raw ?? this.promptText,
							rawError,
						);
					} else {
						this.error =
							event.error ??
							`RPC command failed: ${event.command ?? "unknown"}`;
					}
				}
				// Clear sending flag once RPC acknowledges the prompt.
				// For normal prompts, isStreaming (agent_start/agent_end) gates the UI.
				// For slash commands that bypass the LLM, this prevents a permanent lock.
				if (event.command === "prompt") {
					this.isSendingPrompt = false;
					this.pendingSlashClassification = null;
				}
				// Handle get_state response
				if (event.command === "get_state" && event.success) {
					const state = event.state ?? event.data ?? {};
					this.handleStateUpdate(state);
				}
				// Handle get_available_models response
				if (event.command === "get_available_models" && event.success) {
					const models = event.models ?? event.data?.models ?? [];
					this.availableModels = models;
				}
				// Handle get_session_stats response
				if (event.command === "get_session_stats" && event.success) {
					const stats = event.stats ?? event.data ?? {};
					this.handleSessionStatsUpdate(stats);
				}
				// Handle get_commands response
				if (event.command === "get_commands") {
					this.slashCommandsLoading = false;
					if (event.success) {
						const commands = slashContract.normalizeCommandsPayload(
							event.data ?? event.commands ?? [],
						);
						this.slashCommands = commands;
						this.slashCommandIndex = slashContract.buildCommandIndex(commands);
						this.slashCommandsLoaded = true;
					}
				}
				return;
			}

			if (event.type === "agent_start") {
				this.isStreaming = true;
				this.updateFooter();
				return;
			}

			if (event.type === "agent_end") {
				this.isStreaming = false;
				this.isSendingPrompt = false;
				this.updateFooter();
				// Refresh stats after agent completes
				this.requestSessionStats();
				// Auto-send next queued message
				if (this.promptQueue.length > 0) {
					const next = this.promptQueue.shift();
					this.promptText = next.text;
					this.pendingImages = next.images || [];
					this.$nextTick(() => this.sendPrompt());
				}
				return;
			}

			if (event.type === "state_changed" || event.type === "state_update") {
				if (event.state) {
					this.handleStateUpdate(event.state);
				}
				return;
			}

			if (event.type === "model_changed") {
				if (event.model) {
					this.currentModel = event.model;
				}
				this.updateFooter();
				return;
			}

			if (event.type === "thinking_level_changed") {
				if (event.thinkingLevel) {
					this.currentThinkingLevel = event.thinkingLevel;
				}
				this.updateFooter();
				return;
			}

			if (event.type === "message_start") {
				this.upsertMessage(event.message);
				return;
			}

			if (event.type === "message_update") {
				this.handleAssistantDelta(event);
				return;
			}

			if (event.type === "tool_execution_start") {
				this.handleToolExecutionStart(event);
				return;
			}

			if (event.type === "tool_execution_update") {
				this.handleToolExecutionUpdate(event);
				return;
			}

			if (event.type === "tool_execution_end") {
				this.handleToolExecutionEnd(event);
				return;
			}

			if (event.type === "message_end") {
				this.handleMessageEnd(event);
				return;
			}

			if (event.type === "auto_compaction_start") {
				this.appendBanner(
					"compaction",
					`Compaction started (${event.reason ?? "threshold"})`,
				);
				return;
			}

			if (event.type === "auto_compaction_end") {
				const summary =
					event.result?.summary ??
					event.errorMessage ??
					(event.aborted ? "Compaction aborted" : "Compaction complete");
				this.appendBanner("compaction", summary);
				return;
			}

			if (event.type === "auto_retry_start") {
				const attempt = Number(event.attempt ?? 0);
				const maxAttempts = Number(event.maxAttempts ?? 0);
				const line = `Retry ${attempt}/${maxAttempts} in ${Math.round(Number(event.delayMs ?? 0) / 1000)}s`;
				this.appendBanner("retry", line);
				return;
			}

			if (event.type === "auto_retry_end") {
				const status = event.success
					? "Retry succeeded"
					: `Retry failed: ${event.finalError ?? "unknown error"}`;
				this.appendBanner("retry", status);
				return;
			}

			if (event.type === "extension_error") {
				const line = `${event.extensionPath ?? "extension"}: ${event.error ?? "unknown error"}`;
				this.appendBanner("error", line);
				return;
			}

			if (event.type === "rpc_error" || event.type === "rpc_process_crashed") {
				this.error = event.message ?? "RPC process error";
				this.isSendingPrompt = false;
				return;
			}

			// Extension UI events
			if (event.type === "extension_ui_request") {
				this.handleExtensionUIRequest(event);
				return;
			}

			// Fire-and-forget extension events
			if (event.type === "notify" || event.type === "extension_notify") {
				this.showToast(
					event.message ?? event.text ?? "",
					event.level ?? "info",
					event.duration,
				);
				return;
			}

			if (event.type === "setStatus" || event.type === "extension_status") {
				this.extensionStatus = event.text ?? event.message ?? "";
				this.updateFooter();
				return;
			}

			if (event.type === "setWidget" || event.type === "extension_widget") {
				this.extensionWidget = event.widget ?? event.content ?? null;
				return;
			}

			if (event.type === "setTitle" || event.type === "extension_title") {
				const title = event.title ?? event.text ?? "";
				if (title) {
					document.title = `${title} - Rho Web UI`;
				} else {
					document.title = "Rho Web UI";
				}
				return;
			}
		},

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

			// Merge toolResult into the last assistant message's tool_call parts
			// instead of displaying as a standalone message
			if (role === "toolResult" || role === "tool_result" || role === "tool") {
				const resultOutput = extractToolOutput(rawMessage);
				const toolCallId =
					rawMessage.toolCallId ?? rawMessage.tool_use_id ?? "";
				if (resultOutput) {
					// Find last assistant message and merge into matching tool_call
					for (let j = this.renderedMessages.length - 1; j >= 0; j--) {
						const msg = this.renderedMessages[j];
						if (msg.role !== "assistant") continue;
						// Match by toolCallId or first tool_call without output
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

			// Skip empty messages
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
				if (
					p.type === "compaction" ||
					p.type === "summary" ||
					p.type === "retry"
				)
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
			const messageId =
				eventId || this.streamMessageId || `stream-${Date.now()}`;
			this.streamMessageId = messageId;

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
					stream: {
						textBuffers: {},
						thinkingBuffers: {},
						toolCallBuffers: {},
					},
				};
				this.renderedMessages.push(message);
			}

			if (!message.stream) {
				message.stream = {
					textBuffers: {},
					thinkingBuffers: {},
					toolCallBuffers: {},
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

		scheduleMarkdownRender(messageId, contentIndex) {
			const key = String(contentIndex);
			if (!this.markdownRenderQueue.has(messageId)) {
				this.markdownRenderQueue.set(messageId, new Set());
			}
			this.markdownRenderQueue.get(messageId).add(key);

			// Use 150ms debounced setTimeout instead of requestAnimationFrame
			// to batch rapid streaming token deltas
			if (this.markdownTimeout != null) {
				return;
			}

			this.markdownTimeout = setTimeout(() => {
				this.markdownTimeout = null;
				this.flushMarkdownRender();
			}, 150);
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

				for (const index of indexes) {
					const text = message.stream.textBuffers[index] ?? "";
					const partKey = `${messageId}-stream-text-${index}`;
					const part = this.ensurePart(message, partKey, () => ({
						type: "text",
						key: partKey,
						render: "html",
						content: "",
					}));
					part.render = "html";
					part.content = renderMarkdown(text);
				}
			}

			this.markdownRenderQueue.clear();

			this.$nextTick(() => {
				highlightCodeBlocks(this.$refs.thread);
				this.scrollThreadToBottom();
			});
		},

		handleAssistantDelta(event) {
			const message = this.ensureStreamingMessage(event.message);
			const delta = event.assistantMessageEvent ?? {};
			const deltaType = delta.type;
			const contentIndex = String(delta.contentIndex ?? 0);

			if (deltaType === "text_start") {
				message.stream.textBuffers[contentIndex] = "";
				this.scheduleMarkdownRender(message.id, contentIndex);
				return;
			}

			if (deltaType === "text_delta") {
				message.stream.textBuffers[contentIndex] =
					(message.stream.textBuffers[contentIndex] ?? "") +
					String(delta.delta ?? "");
				this.scheduleMarkdownRender(message.id, contentIndex);
				return;
			}

			if (deltaType === "text_end") {
				if (typeof delta.content === "string") {
					message.stream.textBuffers[contentIndex] = delta.content;
				}
				this.scheduleMarkdownRender(message.id, contentIndex);
				return;
			}

			if (deltaType === "thinking_start") {
				message.stream.thinkingBuffers[contentIndex] = "";
				const key = `${message.id}-stream-thinking-${contentIndex}`;
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

				const key = `${message.id}-stream-thinking-${contentIndex}`;
				const part = this.ensurePart(message, key, () => ({
					type: "thinking",
					key,
					content: "",
				}));
				part.content = renderMarkdown(nextText);

				this.$nextTick(() => {
					highlightCodeBlocks(this.$refs.thread);
					this.scrollThreadToBottom();
				});
				return;
			}

			if (deltaType === "toolcall_start") {
				message.stream.toolCallBuffers[contentIndex] = "";
				const key = `${message.id}-stream-tool-${contentIndex}`;
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

				const key = `${message.id}-stream-tool-${contentIndex}`;
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
				part.argsSummary = clampString(
					argsText.replace(/\s+/g, " ").trim(),
					120,
				);
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

			// Compute semantic view now that we have output
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

			// Calculate duration
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

		startPolling() {
			this.stopPolling();
			this.poller = setInterval(() => {
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
				const total = parseInt(resp.headers.get("X-Total-Count") ?? "0", 10);
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
			this.promptQueue = [];
			this.toolCallPartById.clear();

			// Clear stale RPC
			this.activeRpcSessionId = "";
			this.activeRpcSessionFile = "";
			this.resetSlashCommandsCache();

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
			this.toolCallPartById.clear();

			// Clear stale RPC when switching sessions
			this.activeRpcSessionId = "";
			this.activeRpcSessionFile = "";
			this.resetSlashCommandsCache();

			// Persist in URL for refresh/back (optional)
			if (updateHash && window.location.hash !== `#${sessionId}`) {
				history.replaceState(null, "", `#${sessionId}`);
			}

			// Close sessions panel after selection
			this.showSessionsPanel = false;

			try {
				const session = await fetchJson(`/api/sessions/${sessionId}`);
				this.applySession(session);

				// Auto-start RPC so the session is immediately usable (not read-only)
				const sessionFile = this.getSessionFile(sessionId);
				if (sessionFile) {
					this.startRpcSession(sessionFile);
				}
			} catch (error) {
				this.error = error.message ?? "Failed to load session";
			} finally {
				this.isLoadingSession = false;
			}
		},

		applySession(session) {
			// Don't overwrite live streaming messages with stale disk data
			if (
				this.activeRpcSessionId &&
				(this.isStreaming || this.renderedMessages.length > 0)
			) {
				// Update metadata only
				this.activeSession = {
					...this.activeSession,
					...session,
					messages: undefined,
				};
				return;
			}
			this.activeSession = session;

			// Merge toolResult messages into preceding assistant's tool_call parts
			const rawMessages = session.messages ?? [];
			const mergedMessages = [];
			for (let i = 0; i < rawMessages.length; i++) {
				const msg = rawMessages[i];
				if (
					msg.role === "toolResult" ||
					msg.role === "tool_result" ||
					msg.role === "tool"
				) {
					// Find the last assistant message and merge this result into its tool_call parts
					for (let j = mergedMessages.length - 1; j >= 0; j--) {
						if (mergedMessages[j].role === "assistant") {
							const content = mergedMessages[j].content;
							if (Array.isArray(content)) {
								// Find first tool_call without merged output
								const call = content.find(
									(c) =>
										(c.type === "toolCall" ||
											c.type === "tool_call" ||
											c.type === "tool_use") &&
										!c._merged,
								);
								if (call) {
									const resultText = Array.isArray(msg.content)
										? msg.content
												.map((c) => c.text ?? c.output ?? "")
												.join("\n")
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
					continue; // Don't add toolResult as a separate message
				}
				mergedMessages.push({ ...msg });
			}

			// Normalize messages, filter empty ones, and deduplicate by ID
			const seenIds = new Set();
			const allMessages = mergedMessages
				.map((msg) => normalizeMessage(msg, true))
				.filter((msg) => {
					// Skip empty messages (no parts or all parts empty)
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
						return true; // Unknown part types pass through
					});
					if (!hasContent) {
						return false;
					}
					// Deduplicate by ID
					if (seenIds.has(msg.id)) {
						return false;
					}
					seenIds.add(msg.id);
					return true;
				});

			// Cap to last ~100 messages, track if there are more
			const MESSAGE_CAP = 100;
			this.hasEarlierMessages = allMessages.length > MESSAGE_CAP;
			this.allNormalizedMessages = allMessages; // Store full list for loadEarlierMessages
			this.renderedMessages = allMessages.slice(-MESSAGE_CAP);

			this.userScrolledUp = false;
			this.$nextTick(() => {
				highlightCodeBlocks(this.$refs.thread);
				this.scrollThreadToBottom();
				this.setupLazyRendering();
			});
		},

		sessionLabel(session) {
			if (!session) {
				return "";
			}
			// Show session name, first prompt, or truncated ID
			const rawId = session.header?.id ?? session.id ?? "";
			const firstPrompt = session.firstPrompt;
			const title =
				session.name ||
				(firstPrompt
					? clampString(firstPrompt, 50)
					: rawId
						? rawId.substring(0, 8)
						: "session");
			const timestamp = formatTimestamp(
				session.header?.timestamp ?? session.timestamp,
			);
			return `${title}${timestamp ? ` · ${timestamp}` : ""}`;
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
				alert("No earlier messages available.");
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
				alert("No earlier messages to load.");
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

		latestForkPointId() {
			return this.activeSession?.forkPoints?.at?.(-1)?.id ?? "";
		},

		hasForkPoints() {
			return Boolean(this.latestForkPointId());
		},

		getSessionFile(sessionId) {
			const s = this.sessions.find((s) => s.id === sessionId);
			return s?.file ?? "";
		},

		isForkActive() {
			return Boolean(this.activeRpcSessionId);
		},

		sessionForkBadge(session) {
			if (!session?.parentSession) {
				return "";
			}
			return "fork";
		},

		sessionForkTitle(session) {
			return session?.parentSession
				? `forked from ${session.parentSession}`
				: "";
		},

		canForkMessage(message) {
			return Boolean(message?.canFork && this.activeSessionId);
		},

		async newSession() {
			if (this.isForking) return;
			this.error = "";
			this.isForking = true;

			try {
				const result = await postJson("/api/sessions/new", {});
				this.activeSessionId = result.sessionId;
				this.activeRpcSessionId = "";
				this.activeRpcSessionFile = result.sessionFile;
				this.resetSlashCommandsCache();
				history.replaceState(null, "", `#${result.sessionId}`);
				this.promptText = "";
				this.renderedMessages = [];
				this.applySession(result.session);
				await this.loadSessions(false);
				this.startRpcSession(result.sessionFile);
			} catch (error) {
				this.error = error.message ?? "Failed to create session";
				this.isForking = false;
			}
		},

		async forkFromLatest() {
			const entryId = this.latestForkPointId();
			if (!entryId) {
				this.error = "No user message available to fork from";
				return;
			}
			await this.forkFromEntry(entryId);
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

				this.activeSessionId = forkResult.sessionId;
				this.activeRpcSessionId = "";
				this.activeRpcSessionFile = forkResult.sessionFile;
				this.resetSlashCommandsCache();
				history.replaceState(null, "", `#${forkResult.sessionId}`);
				this.promptText = "";

				this.applySession(forkResult.session);
				await this.loadSessions(false);
				this.startRpcSession(forkResult.sessionFile);

				// Reset scroll state and auto-scroll to bottom after fork
				this.userScrolledUp = false;
				this.scrollThreadToBottom();
			} catch (error) {
				this.error = error.message ?? "Failed to fork session";
				this.isForking = false;
			}
		},

		startRpcSession(sessionFile) {
			const sent = this.sendWs({
				type: "rpc_command",
				sessionFile,
				command: {
					type: "switch_session",
					sessionFile,
					sessionPath: sessionFile,
					path: sessionFile,
				},
			});

			if (!sent) {
				this.isForking = false;
			}
		},

		sendPromptMessage(message, promptOptions = {}, slashClassification = null) {
			const hasImages = this.pendingImages.length > 0;
			if (
				(!message && !hasImages) ||
				!this.activeRpcSessionId ||
				this.isSendingPrompt
			) {
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
				canFork: true,
			});
			this.scrollThreadToBottom();

			const sent = this.sendWs({
				type: "rpc_command",
				sessionId: this.activeRpcSessionId,
				command: {
					type: "prompt",
					message: message || "Describe this image.",
					...promptOptions,
					...(images ? { images } : {}),
				},
			});

			if (!sent) {
				this.isSendingPrompt = false;
			} else {
				this.$nextTick(() => {
					this.scrollThreadToBottom();
				});
			}

			this.focusComposer();
		},

		sendPrompt() {
			const message = this.promptText.trim();
			if (!message) {
				return;
			}
			this.sendPromptMessage(message);
		},

		classifySlashPrompt(message) {
			return slashContract.classifySlashCommand(
				message,
				this.slashCommandIndex,
				{
					interactiveOnlyCommands:
						slashContract.INTERACTIVE_ONLY_SLASH_COMMANDS,
				},
			);
		},

		sendSlashPrompt(message, classification) {
			const promptOptions = slashContract.resolvePromptOptions(
				classification,
				this.isStreaming,
				"steer",
			);
			this.sendPromptMessage(message, promptOptions, classification);
		},

		messageForkPreview(message) {
			const firstText = message?.parts?.find((part) => part.type === "text");
			const text = firstText ? extractText(firstText.content ?? "") : "";
			return (
				clampString(text.replace(/\s+/g, " ").trim(), 80) ||
				"Fork from this prompt"
			);
		},

		// Chat controls methods

		// --- Slash autocomplete ---

		updateSlashAutocomplete() {
			const text = this.promptText;

			// Only trigger when text starts with "/" and is on a single line
			if (
				!text.startsWith("/") ||
				text.startsWith("//") ||
				text.includes("\n")
			) {
				this.closeSlashAutocomplete();
				return;
			}

			if (!this.slashCommandsLoaded) {
				this.requestSlashCommands();
				this.closeSlashAutocomplete();
				return;
			}

			const query = text.slice(1).toLowerCase();
			const MAX_ITEMS = 15;

			const filtered = this.slashCommands
				.filter((cmd) => cmd.name.toLowerCase().includes(query))
				.slice(0, MAX_ITEMS);

			if (filtered.length === 0) {
				this.slashAcItems = [];
				this.slashAcVisible =
					query.length > 0 ? true : this.slashCommands.length > 0;
				this.slashAcIndex = -1;
				if (!this.slashAcVisible) this.closeSlashAutocomplete();
				return;
			}

			this.slashAcItems = filtered;
			this.slashAcVisible = true;

			// Clamp index to new bounds
			if (this.slashAcIndex >= filtered.length) {
				this.slashAcIndex = 0;
			}
			if (this.slashAcIndex < 0) {
				this.slashAcIndex = 0;
			}

			// Scroll active item into view
			this.$nextTick(() => {
				const dropdown = this.$refs.slashAcDropdown;
				if (!dropdown) return;
				const active = dropdown.querySelector(".slash-ac-item.active");
				if (active) {
					active.scrollIntoView({ block: "nearest" });
				}
			});
		},

		closeSlashAutocomplete() {
			this.slashAcVisible = false;
			this.slashAcItems = [];
			this.slashAcIndex = 0;
		},

		selectSlashCommand(item) {
			if (!item) return;
			this.promptText = `/${item.name} `;
			this.closeSlashAutocomplete();
			this.$nextTick(() => {
				const input = this.$refs.composerInput;
				if (input) {
					input.focus();
					// Move cursor to end
					input.selectionStart = input.selectionEnd = input.value.length;
					// Reset textarea height
					input.style.height = "auto";
					input.style.height = `${Math.min(input.scrollHeight, 200)}px`;
				}
			});
		},

		handleSlashAcKeydown(e) {
			if (!this.slashAcVisible) return false;

			if (e.key === "ArrowDown") {
				e.preventDefault();
				if (this.slashAcItems.length > 0) {
					this.slashAcIndex =
						(this.slashAcIndex + 1) % this.slashAcItems.length;
					this.$nextTick(() => {
						const dropdown = this.$refs.slashAcDropdown;
						if (!dropdown) return;
						const active = dropdown.querySelector(".slash-ac-item.active");
						if (active) active.scrollIntoView({ block: "nearest" });
					});
				}
				return true;
			}

			if (e.key === "ArrowUp") {
				e.preventDefault();
				if (this.slashAcItems.length > 0) {
					this.slashAcIndex =
						(this.slashAcIndex - 1 + this.slashAcItems.length) %
						this.slashAcItems.length;
					this.$nextTick(() => {
						const dropdown = this.$refs.slashAcDropdown;
						if (!dropdown) return;
						const active = dropdown.querySelector(".slash-ac-item.active");
						if (active) active.scrollIntoView({ block: "nearest" });
					});
				}
				return true;
			}

			if (e.key === "Tab") {
				e.preventDefault();
				if (this.slashAcItems.length > 0 && this.slashAcIndex >= 0) {
					this.selectSlashCommand(this.slashAcItems[this.slashAcIndex]);
				}
				return true;
			}

			if (e.key === "Enter" && !e.shiftKey) {
				if (this.slashAcItems.length > 0 && this.slashAcIndex >= 0) {
					e.preventDefault();
					this.selectSlashCommand(this.slashAcItems[this.slashAcIndex]);
					return true;
				}
				// No items or no selection — let normal Enter/submit flow through
				this.closeSlashAutocomplete();
				return false;
			}

			if (e.key === "Escape") {
				e.preventDefault();
				this.closeSlashAutocomplete();
				return true;
			}

			return false;
		},

		requestSlashCommands(force = false) {
			if (!this.activeRpcSessionId) {
				return;
			}
			if (this.slashCommandsLoading) {
				return;
			}
			if (
				!force &&
				this.slashCommandsLoaded &&
				this.slashCommandIndex.size > 0
			) {
				return;
			}

			this.slashCommandsLoading = true;
			const sent = this.sendWs({
				type: "rpc_command",
				sessionId: this.activeRpcSessionId,
				command: { type: "get_commands" },
			});

			if (!sent) {
				this.slashCommandsLoading = false;
			}
		},

		requestState() {
			if (!this.activeRpcSessionId) {
				return;
			}
			this.sendWs({
				type: "rpc_command",
				sessionId: this.activeRpcSessionId,
				command: { type: "get_state" },
			});
		},

		requestAvailableModels() {
			if (!this.activeRpcSessionId) {
				return;
			}
			this.sendWs({
				type: "rpc_command",
				sessionId: this.activeRpcSessionId,
				command: { type: "get_available_models" },
			});
		},

		requestSessionStats() {
			if (!this.activeRpcSessionId) {
				return;
			}
			this.sendWs({
				type: "rpc_command",
				sessionId: this.activeRpcSessionId,
				command: { type: "get_session_stats" },
			});
		},

		handleStateUpdate(state) {
			if (state.model) {
				this.currentModel = state.model;
			}
			if (state.thinkingLevel) {
				this.currentThinkingLevel = state.thinkingLevel;
			}
			if (typeof state.isStreaming === "boolean") {
				this.isStreaming = state.isStreaming;
			}
			this.updateFooter();
		},

		handleSessionStatsUpdate(stats) {
			// stats.tokens may be an object { input, output, cacheRead, cacheWrite, total }
			// (pi SessionStats format) or a plain number (legacy)
			const tok = stats.tokens;
			const tokIsObj = tok && typeof tok === "object";
			this.sessionStats = {
				tokens: stats.totalTokens ?? (tokIsObj ? tok.total : tok) ?? 0,
				cost: stats.totalCost ?? stats.cost ?? 0,
				inputTokens: stats.inputTokens ?? (tokIsObj ? tok.input : 0) ?? 0,
				outputTokens: stats.outputTokens ?? (tokIsObj ? tok.output : 0) ?? 0,
				cacheRead:
					stats.cacheRead ??
					stats.cacheReadTokens ??
					(tokIsObj ? tok.cacheRead : 0) ??
					0,
				cacheWrite:
					stats.cacheWrite ??
					stats.cacheCreation ??
					(tokIsObj ? tok.cacheWrite : 0) ??
					0,
			};
			this.updateFooter();
		},

		currentModelLabel() {
			if (!this.currentModel) {
				return "--";
			}
			if (typeof this.currentModel === "string") {
				return this.currentModel;
			}
			const provider = this.currentModel.provider ?? "";
			const modelId = this.currentModel.modelId ?? this.currentModel.id ?? "";
			if (provider && modelId) {
				// Shorten common provider names
				const shortProvider = provider
					.replace("anthropic", "anth")
					.replace("openai", "oai");
				return `${shortProvider}/${modelId}`;
			}
			return modelId || provider || "--";
		},

		modelDropdownLabel(model) {
			if (!model) {
				return "";
			}
			const provider = model.provider ?? "";
			const modelId = model.modelId ?? model.id ?? model.name ?? "";
			if (provider && modelId) {
				return `${provider}/${modelId}`;
			}
			return modelId || provider || "unknown";
		},

		isCurrentModel(model) {
			if (!this.currentModel || !model) {
				return false;
			}
			const currentId =
				this.currentModel.modelId ?? this.currentModel.id ?? this.currentModel;
			const checkId = model.modelId ?? model.id ?? model;
			const currentProvider = this.currentModel.provider ?? "";
			const checkProvider = model.provider ?? "";
			return currentId === checkId && currentProvider === checkProvider;
		},

		setModel(model) {
			if (!this.activeRpcSessionId || this.isStreaming) {
				return;
			}
			this.pendingModelChange = model;
			this.sendWs({
				type: "rpc_command",
				sessionId: this.activeRpcSessionId,
				command: {
					type: "set_model",
					provider: model.provider,
					modelId: model.modelId ?? model.id,
				},
			});
			// Optimistically update
			this.currentModel = model;
			this.updateFooter();
		},

		setThinkingLevel(level) {
			if (!this.activeRpcSessionId || this.isStreaming) {
				return;
			}
			this.sendWs({
				type: "rpc_command",
				sessionId: this.activeRpcSessionId,
				command: {
					type: "set_thinking_level",
					level,
				},
			});
			this.currentThinkingLevel = level;
			this.updateFooter();
		},

		cycleThinkingLevel() {
			if (!this.activeRpcSessionId || this.isStreaming) {
				return;
			}
			const currentIndex = THINKING_LEVELS.indexOf(this.currentThinkingLevel);
			const nextIndex = (currentIndex + 1) % THINKING_LEVELS.length;
			this.setThinkingLevel(THINKING_LEVELS[nextIndex]);
		},

		abort() {
			if (!this.activeRpcSessionId || !this.isStreaming) {
				return;
			}
			this.sendWs({
				type: "rpc_command",
				sessionId: this.activeRpcSessionId,
				command: { type: "abort" },
			});
			// Optimistically reset streaming state so UI returns to "Send" mode
			// immediately. The agent_end event will arrive later to confirm.
			this.isStreaming = false;
			this.isSendingPrompt = false;
			this.promptQueue = [];
			this.updateFooter();
		},

		// ─── Queue management ───

		removeQueueItem(id) {
			this.promptQueue = this.promptQueue.filter((item) => item.id !== id);
		},

		updateQueueItemText(id, text) {
			const item = this.promptQueue.find((item) => item.id === id);
			if (item) item.text = text;
		},

		addQueueItemImage(id, event) {
			const item = this.promptQueue.find((item) => item.id === id);
			if (!item) return;
			const files = event.target?.files;
			if (!files) return;
			for (const file of files) {
				if (!file.type.startsWith("image/")) continue;
				const reader = new FileReader();
				reader.onload = (e) => {
					const dataUrl = e.target.result;
					const base64 = dataUrl.split(",")[1];
					item.images.push({
						data: base64,
						mimeType: file.type,
						dataUrl,
					});
				};
				reader.readAsDataURL(file);
			}
			// Reset file input so same file can be re-selected
			event.target.value = "";
		},

		removeQueueItemImage(id, imageIndex) {
			const item = this.promptQueue.find((item) => item.id === id);
			if (item) item.images.splice(imageIndex, 1);
		},

		mergeQueueItemDown(idx) {
			if (idx >= this.promptQueue.length - 1) return;
			const current = this.promptQueue[idx];
			const next = this.promptQueue[idx + 1];
			current.text = [current.text, next.text].filter(Boolean).join("\n");
			current.images = [...current.images, ...next.images];
			this.promptQueue.splice(idx + 1, 1);
		},

		handlePromptSubmit() {
			const message = this.promptText.trim();
			if (!message && this.pendingImages.length === 0) {
				return;
			}

			const slashClassification = this.classifySlashPrompt(message);
			if (slashClassification.isSlash) {
				if (!this.slashCommandsLoaded) {
					this.requestSlashCommands(true);
					this.error =
						"Loading slash commands from RPC. Try again in a moment.";
					return;
				}

				if (slashClassification.kind !== "supported") {
					this.error =
						slashContract.formatUnsupportedMessage(slashClassification);
					return;
				}

				this.sendSlashPrompt(message, slashClassification);
				return;
			}

			if (this.isStreaming) {
				// During streaming, queue the message with any pending images
				const text = this.promptText.trim();
				const images =
					this.pendingImages.length > 0 ? [...this.pendingImages] : [];
				this.promptQueue.push({
					id: `q-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
					text,
					images,
				});
				this.promptText = "";
				this.pendingImages = [];
				this.showQueue = true;
				this.focusComposer();
			} else {
				// Normal prompt submission
				this.sendPrompt();
			}
		},

		updateFooter() {
			const modelEl = document.querySelector(".footer .footer-model");
			const tokensEl = document.querySelector(".footer .footer-tokens");
			const costEl = document.querySelector(".footer .footer-cost");
			const statusEl = document.querySelector(".footer .footer-status");
			const extStatusEl = document.querySelector(".footer .footer-ext-status");

			if (modelEl) {
				modelEl.textContent = `model: ${this.currentModelLabel()}`;
			}
			if (tokensEl) {
				const tokens = this.sessionStats.tokens || 0;
				tokensEl.textContent = `tokens: ${tokens.toLocaleString()}`;
			}
			if (costEl) {
				const cost = this.sessionStats.cost || 0;
				costEl.textContent = `cost: $${cost.toFixed(4)}`;
			}
			if (statusEl) {
				statusEl.textContent = `status: ${this.isStreaming ? "streaming" : "idle"}`;
				statusEl.classList.toggle("streaming", this.isStreaming);
			}
			if (extStatusEl) {
				extStatusEl.textContent = this.extensionStatus || "";
				extStatusEl.style.display = this.extensionStatus ? "inline" : "none";
			}
		},

		// Helper getters for template
		canSwitchModel() {
			return this.isForkActive() && !this.isStreaming;
		},

		canChangeThinking() {
			return this.isForkActive() && !this.isStreaming;
		},

		canAbort() {
			return this.isForkActive() && this.isStreaming;
		},

		thinkingLevelLabel() {
			return this.currentThinkingLevel || "medium";
		},

		inputPlaceholder() {
			if (!this.isForkActive()) {
				return "Fork a session to start chatting...";
			}
			if (this.isStreaming) {
				return this.promptQueue.length > 0
					? `${this.promptQueue.length} queued — type another or wait`
					: "Type a message (queued until done)...";
			}
			return "Type a prompt...";
		},

		submitButtonLabel() {
			if (this.isStreaming) {
				return this.promptQueue.length > 0
					? `Queue (${this.promptQueue.length})`
					: "Queue";
			}
			return "Send";
		},

		// Extension UI methods

		handleExtensionUIRequest(event) {
			const request = event.request ?? event;
			const method = request.method ?? request.type ?? "";
			const id = request.id ?? `ext-${Date.now()}`;
			const timeout = request.timeout ?? request.timeoutMs ?? 0;

			if (method === "select") {
				this.showSelectDialog(id, request, timeout);
				return;
			}

			if (method === "confirm") {
				this.showConfirmDialog(id, request, timeout);
				return;
			}

			if (method === "input") {
				this.showInputDialog(id, request, timeout);
				return;
			}

			if (method === "editor") {
				this.showEditorDialog(id, request, timeout);
				return;
			}
		},

		showSelectDialog(id, request, timeout) {
			const options = request.options ?? request.choices ?? [];
			const title = request.title ?? request.message ?? "Select an option";
			const description = request.description ?? "";

			this.extensionDialog = {
				id,
				type: "select",
				title,
				description,
				options: options.map((opt, idx) => ({
					value:
						typeof opt === "string"
							? opt
							: (opt.value ?? opt.label ?? String(idx)),
					label:
						typeof opt === "string"
							? opt
							: (opt.label ?? opt.value ?? String(idx)),
					description: typeof opt === "object" ? (opt.description ?? "") : "",
				})),
				selectedValue: null,
				timeoutId: null,
			};

			if (timeout > 0) {
				this.extensionDialog.timeoutId = setTimeout(() => {
					this.dismissDialog(null);
				}, timeout);
			}
		},

		showConfirmDialog(id, request, timeout) {
			const title = request.title ?? request.message ?? "Confirm";
			const description = request.description ?? request.text ?? "";
			const confirmLabel = request.confirmLabel ?? request.yesLabel ?? "Yes";
			const cancelLabel = request.cancelLabel ?? request.noLabel ?? "No";

			this.extensionDialog = {
				id,
				type: "confirm",
				title,
				description,
				confirmLabel,
				cancelLabel,
				timeoutId: null,
			};

			if (timeout > 0) {
				this.extensionDialog.timeoutId = setTimeout(() => {
					this.dismissDialog(false);
				}, timeout);
			}
		},

		showInputDialog(id, request, timeout) {
			const title = request.title ?? request.message ?? "Input";
			const description = request.description ?? "";
			const placeholder = request.placeholder ?? "";
			const defaultValue = request.defaultValue ?? request.value ?? "";

			this.extensionDialog = {
				id,
				type: "input",
				title,
				description,
				placeholder,
				inputValue: defaultValue,
				timeoutId: null,
			};

			if (timeout > 0) {
				this.extensionDialog.timeoutId = setTimeout(() => {
					this.dismissDialog(null);
				}, timeout);
			}
		},

		showEditorDialog(id, request, timeout) {
			const title = request.title ?? request.message ?? "Edit";
			const description = request.description ?? "";
			const content = request.content ?? request.value ?? request.text ?? "";
			const language = request.language ?? "";

			this.extensionDialog = {
				id,
				type: "editor",
				title,
				description,
				language,
				editorContent: content,
				timeoutId: null,
			};

			if (timeout > 0) {
				this.extensionDialog.timeoutId = setTimeout(() => {
					this.dismissDialog(null);
				}, timeout);
			}
		},

		selectDialogOption(option) {
			if (!this.extensionDialog || this.extensionDialog.type !== "select") {
				return;
			}
			this.sendExtensionUIResponse(this.extensionDialog.id, option.value);
			this.closeDialog();
		},

		confirmDialogYes() {
			if (!this.extensionDialog || this.extensionDialog.type !== "confirm") {
				return;
			}
			this.sendExtensionUIResponse(this.extensionDialog.id, true);
			this.closeDialog();
		},

		confirmDialogNo() {
			if (!this.extensionDialog || this.extensionDialog.type !== "confirm") {
				return;
			}
			this.sendExtensionUIResponse(this.extensionDialog.id, false);
			this.closeDialog();
		},

		submitInputDialog() {
			if (!this.extensionDialog || this.extensionDialog.type !== "input") {
				return;
			}
			this.sendExtensionUIResponse(
				this.extensionDialog.id,
				this.extensionDialog.inputValue,
			);
			this.closeDialog();
		},

		submitEditorDialog() {
			if (!this.extensionDialog || this.extensionDialog.type !== "editor") {
				return;
			}
			this.sendExtensionUIResponse(
				this.extensionDialog.id,
				this.extensionDialog.editorContent,
			);
			this.closeDialog();
		},

		dismissDialog(value = null) {
			if (!this.extensionDialog) {
				return;
			}
			this.sendExtensionUIResponse(this.extensionDialog.id, value);
			this.closeDialog();
		},

		closeDialog() {
			if (this.extensionDialog?.timeoutId) {
				clearTimeout(this.extensionDialog.timeoutId);
			}
			this.extensionDialog = null;
		},

		sendExtensionUIResponse(id, value) {
			if (!this.activeRpcSessionId) {
				return;
			}
			this.sendWs({
				type: "extension_ui_response",
				sessionId: this.activeRpcSessionId,
				id,
				value,
			});
		},

		// Toast notifications

		showToast(message, level = "info", duration) {
			const id = ++this.toastIdCounter;
			const toast = {
				id,
				message,
				level,
				style: TOAST_LEVELS[level] ?? TOAST_LEVELS.info,
			};

			this.toasts.push(toast);

			const displayDuration = duration ?? TOAST_DEFAULT_DURATION;
			if (displayDuration > 0) {
				setTimeout(() => {
					this.removeToast(id);
				}, displayDuration);
			}
		},

		removeToast(id) {
			const idx = this.toasts.findIndex((t) => t.id === id);
			if (idx >= 0) {
				this.toasts.splice(idx, 1);
			}
		},

		// Widget display
		hasWidget() {
			return this.extensionWidget != null;
		},

		widgetContent() {
			if (!this.extensionWidget) {
				return "";
			}
			if (typeof this.extensionWidget === "string") {
				return this.extensionWidget;
			}
			return (
				this.extensionWidget.text ??
				this.extensionWidget.content ??
				safeString(this.extensionWidget)
			);
		},

		// Focus management
		focusComposer() {
			this.$nextTick(() => {
				const input = this.$refs.composerInput;
				if (input && !input.disabled) {
					input.focus();
				}
			});
		},
	}));
});
