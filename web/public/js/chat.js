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

function toDiffLines(text) {
	if (text == null || text === "") {
		return [];
	}
	return String(text).replace(/\r\n/g, "\n").split("\n");
}

function buildInlineLineDiff(oldText, newText) {
	const oldLines = toDiffLines(oldText);
	const newLines = toDiffLines(newText);
	const oldLen = oldLines.length;
	const newLen = newLines.length;

	if (oldLen === 0 && newLen === 0) {
		return { lines: [], linesAdded: 0, linesRemoved: 0 };
	}

	const MAX_DIFF_LINES = 600;
	const MAX_DIFF_MATRIX_CELLS = 200_000;
	if (
		oldLen > MAX_DIFF_LINES ||
		newLen > MAX_DIFF_LINES ||
		oldLen * newLen > MAX_DIFF_MATRIX_CELLS
	) {
		let prefix = 0;
		while (
			prefix < oldLen &&
			prefix < newLen &&
			oldLines[prefix] === newLines[prefix]
		) {
			prefix++;
		}

		let oldTail = oldLen - 1;
		let newTail = newLen - 1;
		while (
			oldTail >= prefix &&
			newTail >= prefix &&
			oldLines[oldTail] === newLines[newTail]
		) {
			oldTail--;
			newTail--;
		}

		const linesRemoved = Math.max(0, oldTail - prefix + 1);
		const linesAdded = Math.max(0, newTail - prefix + 1);
		return { lines: [], linesAdded, linesRemoved, truncated: true };
	}

	const dp = Array.from(
		{ length: oldLen + 1 },
		() => new Uint32Array(newLen + 1),
	);
	for (let i = oldLen - 1; i >= 0; i--) {
		const row = dp[i];
		const nextRow = dp[i + 1];
		for (let j = newLen - 1; j >= 0; j--) {
			if (oldLines[i] === newLines[j]) {
				row[j] = nextRow[j + 1] + 1;
			} else {
				row[j] = Math.max(nextRow[j], row[j + 1]);
			}
		}
	}

	const lines = [];
	let i = 0;
	let j = 0;
	let oldNum = 1;
	let newNum = 1;
	let linesAdded = 0;
	let linesRemoved = 0;

	while (i < oldLen && j < newLen) {
		if (oldLines[i] === newLines[j]) {
			lines.push({
				type: "ctx",
				old: oldNum++,
				new: newNum++,
				text: oldLines[i],
			});
			i++;
			j++;
			continue;
		}

		if (dp[i + 1][j] >= dp[i][j + 1]) {
			lines.push({ type: "del", old: oldNum++, new: null, text: oldLines[i] });
			linesRemoved++;
			i++;
		} else {
			lines.push({ type: "add", old: null, new: newNum++, text: newLines[j] });
			linesAdded++;
			j++;
		}
	}

	while (i < oldLen) {
		lines.push({ type: "del", old: oldNum++, new: null, text: oldLines[i++] });
		linesRemoved++;
	}
	while (j < newLen) {
		lines.push({ type: "add", old: null, new: newNum++, text: newLines[j++] });
		linesAdded++;
	}

	return { lines, linesAdded, linesRemoved };
}

const TOOL_REGISTRY = {
	edit(args, output) {
		const a = safeJsonParse(args) || {};
		const path = a.path || "";
		const hasOldNew =
			typeof a.oldText === "string" && typeof a.newText === "string";
		const oldText = typeof a.oldText === "string" ? a.oldText : "";
		const newText = typeof a.newText === "string" ? a.newText : "";
		const inlineDiff = hasOldNew
			? buildInlineLineDiff(oldText, newText)
			: { lines: [], linesAdded: 0, linesRemoved: 0 };
		const maxRenderLines = 260;
		const diffTotalLines = inlineDiff.lines.length;
		const diffLines =
			diffTotalLines > maxRenderLines
				? inlineDiff.lines.slice(0, maxRenderLines)
				: inlineDiff.lines;
		const success =
			!output || /successfully/i.test(output) || /replaced/i.test(output);
		return {
			tool: "edit",
			path,
			filename: extractFilename(path),
			lang: langFromPath(path),
			hasOldNew,
			oldText,
			newText,
			linesRemoved: inlineDiff.linesRemoved,
			linesAdded: inlineDiff.linesAdded,
			diffLines,
			diffTotalLines,
			diffTruncated: diffTotalLines > maxRenderLines,
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
	"gpt-5.3-codex": 272000,
	"gpt-5.2-codex": 272000,
	"gpt-5.1-codex": 272000,
	"gpt-5-codex": 272000,
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

function supportsXhighThinking(model) {
	if (!model || typeof model !== "object") {
		return false;
	}
	const modelId = String(model.modelId ?? model.id ?? model.name ?? "")
		.trim()
		.toLowerCase();
	if (!modelId) {
		return false;
	}
	return (
		/^gpt-5\.1-codex-max(?:-|$)/.test(modelId) ||
		/^gpt-5\.2(?:-codex)?(?:-|$)/.test(modelId) ||
		/^gpt-5\.3(?:-codex)?(?:-|$)/.test(modelId)
	);
}

function resolveModelCapabilities(model, availableModels) {
	if (!model || typeof model !== "object") {
		return null;
	}
	const provider = String(model.provider ?? "").toLowerCase();
	const modelId = String(
		model.modelId ?? model.id ?? model.name ?? "",
	).toLowerCase();
	if (!modelId || !Array.isArray(availableModels)) {
		return model;
	}
	return (
		availableModels.find((candidate) => {
			const candidateProvider = String(candidate.provider ?? "").toLowerCase();
			const candidateId = String(
				candidate.modelId ?? candidate.id ?? candidate.name ?? "",
			).toLowerCase();
			if (!candidateId) {
				return false;
			}
			if (provider) {
				return candidateProvider === provider && candidateId === modelId;
			}
			return candidateId === modelId;
		}) ?? model
	);
}

function thinkingLevelsForModel(model, availableModels) {
	const capabilities = resolveModelCapabilities(model, availableModels);
	if (!capabilities || !capabilities.reasoning) {
		return ["off"];
	}
	const levels = [...THINKING_LEVELS_BASE];
	if (supportsXhighThinking(capabilities)) {
		levels.push("xhigh");
	}
	return levels;
}

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
		showQueue: false,

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
		thinkingLevels: [...THINKING_LEVELS_BASE],
		currentModel: null,
		currentThinkingLevel: "medium",
		isStreaming: false,
		sessionStats: { tokens: 0, cost: 0 },
		usageAccountedMessageIds: new Set(),
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
		reconnectBannerMessage: "",
		streamDisconnectedDuringResponse: false,
		awaitingStreamReconnectState: false,
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
								if (part.type === "thinking") {
									part.content = renderMarkdown(
										part.rawContent || part.content,
									);
									part.isRendered = true;
									modified = true;
									return;
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
				this.wsReconnectAttempts = 0;
				this.error = "";

				if (this.awaitingStreamReconnectState) {
					this.showReconnectBanner = true;
					this.reconnectBannerMessage = "Reconnected. Checking stream status…";
				} else {
					this.showReconnectBanner = false;
					this.reconnectBannerMessage = "";
				}

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
				// Fetch initial state and available models.
				// Stats are requested after state/switch response to avoid
				// racing a transient zero snapshot on session startup.
				this.requestState();
				this.requestAvailableModels();
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
				if (event.command === "switch_session" && event.success) {
					this.requestSessionStats();
				}
				// Handle get_state response
				if (event.command === "get_state" && event.success) {
					const state = event.state ?? event.data ?? {};
					this.handleStateUpdate(state);
					this.requestSessionStats();
				}
				// Handle get_available_models response
				if (event.command === "get_available_models" && event.success) {
					const models = event.models ?? event.data?.models ?? [];
					this.availableModels = models;
					this.syncThinkingLevels();
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
				if (this.streamDisconnectedDuringResponse && this.isWsConnected) {
					this.streamDisconnectedDuringResponse = false;
					this.showReconnectBanner = false;
					this.reconnectBannerMessage = "";
				}
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
				this.syncThinkingLevels();
				this.updateFooter();
				return;
			}

			if (event.type === "thinking_level_changed") {
				if (event.thinkingLevel) {
					this.currentThinkingLevel = normalizeThinkingLevel(
						event.thinkingLevel,
					);
				}
				this.syncThinkingLevels();
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
					options.sessionFile || this.getSessionFile(sessionId);
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

			this.syncSessionStatsFromSession(session, mergedMessages);
			this.seedUsageAccumulator(mergedMessages);

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
				canFork: false,
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

		syncThinkingLevels() {
			const levels = thinkingLevelsForModel(
				this.currentModel,
				this.availableModels,
			);
			this.thinkingLevels = levels;
			const normalized = normalizeThinkingLevel(this.currentThinkingLevel);
			if (!levels.includes(normalized)) {
				this.currentThinkingLevel = levels.includes("medium")
					? "medium"
					: (levels[0] ?? "off");
				return;
			}
			this.currentThinkingLevel = normalized;
		},

		resolveInterruptedStreamState() {
			if (!this.awaitingStreamReconnectState) {
				return;
			}

			this.awaitingStreamReconnectState = false;

			if (this.isStreaming) {
				this.showReconnectBanner = true;
				this.reconnectBannerMessage =
					"Reconnected — agent is still responding.";
				return;
			}

			if (this.streamDisconnectedDuringResponse) {
				this.showReconnectBanner = true;
				this.reconnectBannerMessage =
					"Reconnected — previous response may be incomplete. Reloading…";
				this.streamDisconnectedDuringResponse = false;
				this.$nextTick(() => this.reloadActiveSession());
				setTimeout(() => {
					if (!this.isStreaming && this.isWsConnected) {
						this.showReconnectBanner = false;
						this.reconnectBannerMessage = "";
					}
				}, 2200);
				return;
			}

			this.showReconnectBanner = false;
			this.reconnectBannerMessage = "";
		},

		handleStateUpdate(state) {
			if (state.model) {
				this.currentModel = state.model;
			}
			if (state.thinkingLevel) {
				this.currentThinkingLevel = normalizeThinkingLevel(state.thinkingLevel);
			}
			if (typeof state.isStreaming === "boolean") {
				this.isStreaming = state.isStreaming;
			}
			this.resolveInterruptedStreamState();
			this.syncThinkingLevels();
			this.updateFooter();
		},

		handleSessionStatsUpdate(stats) {
			const statsObj = stats && typeof stats === "object" ? stats : {};
			const tok = statsObj.tokens;
			const tokObj = tok && typeof tok === "object" ? tok : null;

			const inputTokens =
				toFiniteNumber(statsObj.inputTokens) ??
				toFiniteNumber(
					tokObj?.input ?? tokObj?.promptTokens ?? tokObj?.inputTokens,
				) ??
				0;
			const outputTokens =
				toFiniteNumber(statsObj.outputTokens) ??
				toFiniteNumber(
					tokObj?.output ?? tokObj?.completionTokens ?? tokObj?.outputTokens,
				) ??
				0;
			const cacheRead =
				toFiniteNumber(statsObj.cacheRead) ??
				toFiniteNumber(statsObj.cacheReadTokens) ??
				toFiniteNumber(tokObj?.cacheRead ?? tokObj?.cache_read) ??
				0;
			const cacheWrite =
				toFiniteNumber(statsObj.cacheWrite) ??
				toFiniteNumber(statsObj.cacheCreation) ??
				toFiniteNumber(tokObj?.cacheWrite ?? tokObj?.cache_write) ??
				0;

			const totalTokens =
				toFiniteNumber(statsObj.totalTokens) ??
				toFiniteNumber(statsObj.tokenUsage) ??
				toFiniteNumber(statsObj.tokensTotal) ??
				toFiniteNumber(
					tokObj?.total ??
						tokObj?.totalTokens ??
						tokObj?.total_tokens ??
						tokObj?.tokens,
				) ??
				toFiniteNumber(tok) ??
				inputTokens + outputTokens + cacheRead + cacheWrite;

			const cost =
				toFiniteNumber(statsObj.totalCost) ??
				toFiniteNumber(statsObj.costTotal) ??
				toFiniteNumber(statsObj.cost?.total) ??
				toFiniteNumber(statsObj.cost) ??
				0;

			const currentTokens = toFiniteNumber(this.sessionStats?.tokens) ?? 0;
			const currentCost = toFiniteNumber(this.sessionStats?.cost) ?? 0;
			const currentInput = toFiniteNumber(this.sessionStats?.inputTokens) ?? 0;
			const currentOutput =
				toFiniteNumber(this.sessionStats?.outputTokens) ?? 0;
			const currentCacheRead =
				toFiniteNumber(this.sessionStats?.cacheRead) ?? 0;
			const currentCacheWrite =
				toFiniteNumber(this.sessionStats?.cacheWrite) ?? 0;

			const incomingAllZero =
				totalTokens === 0 &&
				cost === 0 &&
				inputTokens === 0 &&
				outputTokens === 0 &&
				cacheRead === 0 &&
				cacheWrite === 0;
			const hasCurrentUsage =
				currentTokens > 0 ||
				currentCost > 0 ||
				currentInput > 0 ||
				currentOutput > 0 ||
				currentCacheRead > 0 ||
				currentCacheWrite > 0;

			// Ignore transient zero snapshots from RPC startup that would
			// clobber stats already reconstructed from the loaded session.
			if (hasCurrentUsage && incomingAllZero) {
				return;
			}

			this.sessionStats = {
				tokens: Math.max(currentTokens, totalTokens),
				cost: Math.max(currentCost, cost),
				inputTokens: Math.max(currentInput, inputTokens),
				outputTokens: Math.max(currentOutput, outputTokens),
				cacheRead: Math.max(currentCacheRead, cacheRead),
				cacheWrite: Math.max(currentCacheWrite, cacheWrite),
			};
			this.updateFooter();
		},

		syncSessionStatsFromSession(session, messages = []) {
			const sessionStats = session?.stats ?? {};
			const tokensFromSession =
				toFiniteNumber(sessionStats.totalTokens) ??
				toFiniteNumber(sessionStats.tokenUsage) ??
				toFiniteNumber(sessionStats.tokens);
			const costFromSession =
				toFiniteNumber(sessionStats.totalCost) ??
				toFiniteNumber(sessionStats.cost?.total) ??
				toFiniteNumber(sessionStats.cost);

			let inputTokens = 0;
			let outputTokens = 0;
			let cacheRead = 0;
			let cacheWrite = 0;
			let tokensFromMessages = 0;
			let costFromMessages = 0;

			const usageMessages = Array.isArray(messages) ? messages : [];
			for (const message of usageMessages) {
				const totals = parseUsageTotals(message?.usage);
				inputTokens += totals.input;
				outputTokens += totals.output;
				cacheRead += totals.cacheRead;
				cacheWrite += totals.cacheWrite;
				tokensFromMessages += totals.total;
				costFromMessages += totals.cost ?? 0;
			}

			this.sessionStats = {
				tokens: tokensFromSession ?? tokensFromMessages,
				cost: costFromSession ?? costFromMessages,
				inputTokens,
				outputTokens,
				cacheRead,
				cacheWrite,
			};
			this.updateFooter();
		},

		seedUsageAccumulator(messages = []) {
			this.usageAccountedMessageIds.clear();
			const usageMessages = Array.isArray(messages) ? messages : [];
			for (const message of usageMessages) {
				if (!message || message.role !== "assistant") {
					continue;
				}
				const messageId = String(message.id ?? "");
				if (!messageId) {
					continue;
				}
				const totals = parseUsageTotals(message.usage);
				const hasUsage =
					totals.input > 0 ||
					totals.output > 0 ||
					totals.cacheRead > 0 ||
					totals.cacheWrite > 0 ||
					totals.total > 0 ||
					(totals.cost ?? 0) > 0;
				if (hasUsage) {
					this.usageAccountedMessageIds.add(messageId);
				}
			}
		},

		accumulateUsageFromMessage(message) {
			if (!message || message.role !== "assistant") {
				return;
			}

			const messageId = String(message.id ?? "");
			if (messageId && this.usageAccountedMessageIds.has(messageId)) {
				return;
			}

			const totals = parseUsageTotals(message.usage);
			const cost = totals.cost ?? 0;
			const fallbackTotal =
				totals.input + totals.output + totals.cacheRead + totals.cacheWrite;
			const totalTokens = totals.total || fallbackTotal;
			const hasUsage =
				totalTokens > 0 ||
				totals.input > 0 ||
				totals.output > 0 ||
				totals.cacheRead > 0 ||
				totals.cacheWrite > 0 ||
				cost > 0;
			if (!hasUsage) {
				return;
			}

			const currentTokens = toFiniteNumber(this.sessionStats?.tokens) ?? 0;
			const currentCost = toFiniteNumber(this.sessionStats?.cost) ?? 0;
			const currentInput = toFiniteNumber(this.sessionStats?.inputTokens) ?? 0;
			const currentOutput =
				toFiniteNumber(this.sessionStats?.outputTokens) ?? 0;
			const currentCacheRead =
				toFiniteNumber(this.sessionStats?.cacheRead) ?? 0;
			const currentCacheWrite =
				toFiniteNumber(this.sessionStats?.cacheWrite) ?? 0;

			this.sessionStats = {
				tokens: currentTokens + totalTokens,
				cost: currentCost + cost,
				inputTokens: currentInput + totals.input,
				outputTokens: currentOutput + totals.output,
				cacheRead: currentCacheRead + totals.cacheRead,
				cacheWrite: currentCacheWrite + totals.cacheWrite,
			};
			if (messageId) {
				this.usageAccountedMessageIds.add(messageId);
			}
			this.updateFooter();
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
			this.syncThinkingLevels();
			this.updateFooter();
		},

		setThinkingLevel(level) {
			if (!this.activeRpcSessionId || this.isStreaming) {
				return;
			}
			const normalizedLevel = normalizeThinkingLevel(level);
			if (!this.thinkingLevels.includes(normalizedLevel)) {
				return;
			}
			this.sendWs({
				type: "rpc_command",
				sessionId: this.activeRpcSessionId,
				command: {
					type: "set_thinking_level",
					level: normalizedLevel,
				},
			});
			this.currentThinkingLevel = normalizedLevel;
			this.updateFooter();
		},

		cycleThinkingLevel() {
			if (!this.activeRpcSessionId || this.isStreaming) {
				return;
			}
			const levels = this.thinkingLevels.length ? this.thinkingLevels : ["off"];
			const current = normalizeThinkingLevel(this.currentThinkingLevel);
			const currentIndex = levels.indexOf(current);
			const nextIndex = (currentIndex + 1) % levels.length;
			this.setThinkingLevel(levels[nextIndex]);
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
				this.focusComposer();
			} else {
				// Normal prompt submission
				this.sendPrompt();
			}
		},

		updateFooter() {
			const tokensEl = document.querySelector(".footer .footer-tokens");
			const costEl = document.querySelector(".footer .footer-cost");
			const statusEl = document.querySelector(".footer .footer-status");
			const extStatusEl = document.querySelector(".footer .footer-ext-status");

			if (tokensEl) {
				const tokens = toFiniteNumber(this.sessionStats?.tokens) ?? 0;
				tokensEl.textContent = `tokens: ${tokens.toLocaleString()}`;
			}
			if (costEl) {
				const cost = toFiniteNumber(this.sessionStats?.cost) ?? 0;
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
				return "Streaming… send to queue";
			}
			return "Type a prompt...";
		},

		submitButtonLabel() {
			if (this.isStreaming) {
				return "Queue";
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
		shouldDismissKeyboardAfterSend() {
			if (
				typeof window === "undefined" ||
				typeof window.matchMedia !== "function"
			) {
				return false;
			}
			return (
				window.matchMedia("(max-width: 720px)").matches ||
				window.matchMedia("(pointer: coarse)").matches
			);
		},

		blurComposer() {
			const input = this.$refs.composerInput;
			if (input && typeof input.blur === "function") {
				input.blur();
			}
		},

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
