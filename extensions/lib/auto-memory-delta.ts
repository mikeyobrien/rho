import crypto from "node:crypto";

export interface AutoMemoryCursorLike {
	processedCount: number;
	lastProcessedHash: string | null;
}

export interface AutoMemoryRange {
	startIndex: number;
	contextStartIndex: number;
	newMessageCount: number;
	lastMessageHash: string | null;
}

function hashMessage(message: unknown): string {
	return crypto
		.createHash("sha256")
		.update(JSON.stringify(message ?? null))
		.digest("hex")
		.slice(0, 16);
}

export function resolveAutoMemoryRange(
	messages: unknown[],
	cursor?: AutoMemoryCursorLike | null,
	contextWindow = 4,
): AutoMemoryRange {
	const safeMessages = Array.isArray(messages) ? messages : [];
	if (safeMessages.length === 0) {
		return {
			startIndex: 0,
			contextStartIndex: 0,
			newMessageCount: 0,
			lastMessageHash: null,
		};
	}

	const hashes = safeMessages.map(hashMessage);
	const fallbackStart = 0;
	let startIndex = Math.max(
		0,
		Math.min(
			safeMessages.length,
			typeof cursor?.processedCount === "number" &&
				Number.isFinite(cursor.processedCount)
				? Math.floor(cursor.processedCount)
				: 0,
		),
	);

	const lastProcessedHash =
		typeof cursor?.lastProcessedHash === "string" &&
		cursor.lastProcessedHash.trim()
			? cursor.lastProcessedHash
			: null;

	if (lastProcessedHash && startIndex > 0) {
		if (hashes[startIndex - 1] !== lastProcessedHash) {
			const foundIndex = hashes.lastIndexOf(lastProcessedHash);
			startIndex = foundIndex >= 0 ? foundIndex + 1 : fallbackStart;
		}
	}

	startIndex = Math.max(0, Math.min(startIndex, safeMessages.length));
	const contextStartIndex = Math.max(
		0,
		startIndex - Math.max(0, contextWindow),
	);
	return {
		startIndex,
		contextStartIndex,
		newMessageCount: Math.max(0, safeMessages.length - startIndex),
		lastMessageHash: hashes[hashes.length - 1] ?? null,
	};
}
