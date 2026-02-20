import type {
	BranchSummaryEntry,
	CompactionEntry,
	CustomMessageEntry,
	ForkPoint,
	MessageEntry,
	ParsedMessage,
	SessionEntryBase,
} from "./session-reader-types.ts";

export function buildSessionContext(
	entries: SessionEntryBase[],
	entryMap: Map<string, SessionEntryBase>,
): {
	messages: ParsedMessage[];
	forkPoints: ForkPoint[];
	stats: { messageCount: number; tokenUsage: number; cost: number };
} {
	const leaf = findLeafEntry(entries);
	if (!leaf?.id) {
		return {
			messages: [],
			forkPoints: [],
			stats: { messageCount: 0, tokenUsage: 0, cost: 0 },
		};
	}

	const entryPath = buildPath(entryMap, leaf.id);
	const compactionIndex = findLastIndex(
		entryPath,
		(entry) => entry.type === "compaction",
	);
	let startIndex = 0;
	let compactionSummary: ParsedMessage | null = null;

	if (compactionIndex >= 0) {
		const compaction = entryPath[compactionIndex] as CompactionEntry;
		compactionSummary = formatCompaction(compaction);
		if (compaction.firstKeptEntryId) {
			const keptIndex = entryPath.findIndex(
				(entry) => entry.id === compaction.firstKeptEntryId,
			);
			startIndex = keptIndex >= 0 ? keptIndex : compactionIndex + 1;
		} else {
			startIndex = compactionIndex + 1;
		}
	}

	const messages: ParsedMessage[] = [];
	const forkPoints: ForkPoint[] = [];
	let tokenUsage = 0;
	let cost = 0;

	if (compactionSummary) {
		messages.push(compactionSummary);
	}

	const pathSlice = entryPath.slice(startIndex);
	for (const entry of pathSlice) {
		const parsed = toParsedMessage(entry);
		if (!parsed) {
			continue;
		}
		if (compactionSummary && entry.type === "compaction") {
			continue;
		}

		messages.push(parsed);

		if (parsed.role === "user") {
			const text = extractPreview(parsed.content);
			if (text) {
				forkPoints.push({ id: parsed.id, text, timestamp: parsed.timestamp });
			}
		}

		const usage = parsed.usage as Record<string, unknown> | undefined;
		if (!usage) {
			continue;
		}

		const input =
			asNumber(usage.input) ??
			asNumber(usage.promptTokens) ??
			asNumber(usage.prompt_tokens) ??
			asNumber(usage.inputTokens) ??
			asNumber(usage.input_tokens) ??
			0;
		const output =
			asNumber(usage.output) ??
			asNumber(usage.completionTokens) ??
			asNumber(usage.completion_tokens) ??
			asNumber(usage.outputTokens) ??
			asNumber(usage.output_tokens) ??
			0;
		const cacheRead =
			asNumber(usage.cacheRead) ??
			asNumber(usage.cache_read) ??
			asNumber(usage.cacheReadTokens) ??
			asNumber(usage.cache_read_input_tokens) ??
			0;
		const cacheWrite =
			asNumber(usage.cacheWrite) ??
			asNumber(usage.cache_write) ??
			asNumber(usage.cacheCreation) ??
			asNumber(usage.cacheCreationInputTokens) ??
			asNumber(usage.cache_creation_input_tokens) ??
			0;

		const totalTokens =
			asNumber(usage.totalTokens) ??
			asNumber(usage.total_tokens) ??
			asNumber(usage.total) ??
			asNumber(usage.tokens);
		tokenUsage += totalTokens ?? input + output + cacheRead + cacheWrite;

		const costObj =
			typeof usage.cost === "object" && usage.cost
				? (usage.cost as Record<string, unknown>)
				: undefined;
		const costValue =
			asNumber(costObj?.total) ??
			asNumber(usage.costTotal) ??
			asNumber(usage.totalCost) ??
			asNumber(usage.usd) ??
			asNumber(usage.cost);
		if (costValue != null) {
			cost += costValue;
		} else if (costObj) {
			cost +=
				(asNumber(costObj.input) ?? 0) +
				(asNumber(costObj.output) ?? 0) +
				(asNumber(costObj.cacheRead ?? costObj.cache_read) ?? 0) +
				(asNumber(costObj.cacheWrite ?? costObj.cache_write) ?? 0);
		}
	}

	return {
		messages,
		forkPoints,
		stats: { messageCount: messages.length, tokenUsage, cost },
	};
}

export function extractPreview(content: unknown): string {
	if (content == null) {
		return "";
	}
	if (typeof content === "string") {
		return content.trim();
	}
	if (Array.isArray(content)) {
		const textParts = content
			.map((part) => {
				if (typeof part === "string") {
					return part;
				}
				if (part && typeof part === "object" && "text" in part) {
					return String((part as { text?: unknown }).text ?? "");
				}
				return "";
			})
			.filter(Boolean);
		return textParts.join(" ").trim();
	}
	if (
		typeof content === "object" &&
		"text" in (content as { text?: unknown })
	) {
		return String((content as { text?: unknown }).text ?? "").trim();
	}
	return "";
}

export function parseTimestampFromFilename(value: string): string | undefined {
	const match = value.match(
		/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/,
	);
	if (!match) {
		return undefined;
	}
	return `${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z`;
}

function findLeafEntry(entries: SessionEntryBase[]): SessionEntryBase | null {
	for (let i = entries.length - 1; i >= 0; i -= 1) {
		const entry = entries[i];
		if (!entry.id || entry.type === "label") {
			continue;
		}
		return entry;
	}
	return null;
}

function buildPath(
	entryMap: Map<string, SessionEntryBase>,
	leafId: string,
): SessionEntryBase[] {
	const path: SessionEntryBase[] = [];
	const visited = new Set<string>();
	let current = entryMap.get(leafId);

	while (current?.id && !visited.has(current.id)) {
		visited.add(current.id);
		path.push(current);
		const parentId = current.parentId ?? null;
		if (!parentId) {
			break;
		}
		current = entryMap.get(parentId) ?? null;
	}

	return path.reverse();
}

function toParsedMessage(entry: SessionEntryBase): ParsedMessage | null {
	if (!entry.id) {
		return null;
	}

	switch (entry.type) {
		case "message": {
			const messageEntry = entry as MessageEntry;
			return {
				id: messageEntry.id,
				parentId: messageEntry.parentId ?? null,
				role: messageEntry.message?.role ?? "assistant",
				content: messageEntry.message?.content ?? messageEntry.message ?? null,
				timestamp: messageEntry.timestamp ?? "",
				usage: messageEntry.message?.usage,
				model: messageEntry.message?.model ?? messageEntry.message?.modelId,
			};
		}
		case "custom_message": {
			const custom = entry as CustomMessageEntry;
			return {
				id: custom.id,
				parentId: custom.parentId ?? null,
				role: "custom",
				content: custom.content ?? null,
				timestamp: custom.timestamp ?? "",
			};
		}
		case "branch_summary": {
			const summary = entry as BranchSummaryEntry;
			return {
				id: summary.id,
				parentId: summary.parentId ?? null,
				role: "summary",
				content: {
					type: "branch_summary",
					summary: summary.summary ?? "",
					fromId: summary.fromId,
					details: summary.details,
				},
				timestamp: summary.timestamp ?? "",
			};
		}
		case "compaction": {
			return formatCompaction(entry as CompactionEntry);
		}
		default:
			return null;
	}
}

function formatCompaction(entry: CompactionEntry): ParsedMessage {
	return {
		id: entry.id ?? "",
		parentId: entry.parentId ?? null,
		role: "summary",
		content: {
			type: "compaction",
			summary: entry.summary ?? "",
			firstKeptEntryId: entry.firstKeptEntryId,
			tokensBefore: entry.tokensBefore,
			details: entry.details,
		},
		timestamp: entry.timestamp ?? "",
	};
}

function findLastIndex<T>(items: T[], predicate: (item: T) => boolean): number {
	for (let i = items.length - 1; i >= 0; i -= 1) {
		if (predicate(items[i])) {
			return i;
		}
	}
	return -1;
}

function asNumber(value: unknown): number | undefined {
	if (typeof value === "number") {
		return value;
	}
	if (typeof value === "string") {
		const parsed = Number(value);
		return Number.isNaN(parsed) ? undefined : parsed;
	}
	return undefined;
}
