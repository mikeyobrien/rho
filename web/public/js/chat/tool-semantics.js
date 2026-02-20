import {
	clampString,
	generateOutputPreview,
	parseToolSemantic,
	safeString,
	semanticHeaderSummary,
} from "./constants-and-primitives.js";

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

export {
	semanticOutputSummary,
	isFileEditTool,
	parseToolOutput,
	extractText,
	normalizeToolCall,
	normalizeContentItem,
	normalizeParts,
	formatModel,
	MODEL_CONTEXT_WINDOWS,
};
