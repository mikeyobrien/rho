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

export {
	CHAT_REFRESH_INTERVAL,
	slashContract,
	safeString,
	clampString,
	generateOutputPreview,
	safeJsonParse,
	extractFilename,
	fileExtension,
	EXT_TO_LANG,
	langFromPath,
	toDiffLines,
	buildInlineLineDiff,
	TOOL_REGISTRY,
	parseToolSemantic,
	semanticHeaderSummary,
};
