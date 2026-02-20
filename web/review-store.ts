import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import { withFileLock } from "../extensions/lib/file-lock.ts";
import { getRhoHome } from "./config.ts";

export type ReviewStatus =
	| "open"
	| "submitted"
	| "cancelled"
	| "claimed"
	| "resolved";

export type ReviewListStatus = ReviewStatus | "all" | "inbox";

export interface ReviewCommentRecord {
	file: string;
	startLine: number;
	endLine: number;
	selectedText: string;
	comment: string;
}

export interface ReviewRequestRecord {
	files: string[];
	warnings: string[];
	message?: string;
	cwd?: string;
	branch?: string;
	commit?: string;
	source?: "tool" | "git" | "manual";
}

export interface ReviewSubmissionRecord {
	comments: ReviewCommentRecord[];
}

export interface StoredReviewRecord {
	id: string;
	status: ReviewStatus;
	createdAt: number;
	updatedAt: number;
	submittedAt: number | null;
	cancelledAt: number | null;
	claimedAt: number | null;
	claimedBy: string | null;
	resolvedAt: number | null;
	resolvedBy: string | null;
	request: ReviewRequestRecord;
	submission: ReviewSubmissionRecord | null;
	resultSummary: {
		commentCount: number;
	};
}

interface ReviewSnapshotEvent {
	type: "review_snapshot";
	version: 1;
	created: string;
	review: StoredReviewRecord;
}

export class ReviewStoreError extends Error {
	readonly code: "NOT_FOUND" | "CONFLICT" | "INVALID_STATE" | "INVALID_INPUT";

	constructor(
		code: "NOT_FOUND" | "CONFLICT" | "INVALID_STATE" | "INVALID_INPUT",
		message: string,
	) {
		super(message);
		this.code = code;
		this.name = "ReviewStoreError";
	}
}

const DEFAULT_REVIEW_STORE_PATH =
	process.env.RHO_REVIEW_STORE_PATH ??
	path.join(getRhoHome(), "review", "reviews.jsonl");

export function getReviewStorePath(): string {
	return DEFAULT_REVIEW_STORE_PATH;
}

function normalizeStatusFilter(
	status: ReviewListStatus | undefined,
): Set<ReviewStatus> {
	if (!status || status === "inbox") {
		return new Set<ReviewStatus>(["submitted", "claimed"]);
	}
	if (status === "all") {
		return new Set<ReviewStatus>([
			"open",
			"submitted",
			"cancelled",
			"claimed",
			"resolved",
		]);
	}
	return new Set<ReviewStatus>([status]);
}

function isSnapshotEvent(value: unknown): value is ReviewSnapshotEvent {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Partial<ReviewSnapshotEvent>;
	if (candidate.type !== "review_snapshot") return false;
	if (candidate.version !== 1) return false;
	if (!candidate.review || typeof candidate.review !== "object") return false;
	if (typeof (candidate.review as StoredReviewRecord).id !== "string")
		return false;
	if (typeof (candidate.review as StoredReviewRecord).status !== "string")
		return false;
	return true;
}

async function readSnapshotMap(
	storePath: string,
): Promise<Map<string, StoredReviewRecord>> {
	let raw = "";
	try {
		raw = await readFile(storePath, "utf-8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return new Map();
		}
		throw error;
	}

	if (!raw.trim()) return new Map();

	const map = new Map<string, StoredReviewRecord>();
	const lines = raw.split("\n");
	for (const line of lines) {
		if (!line.trim()) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			continue;
		}
		if (!isSnapshotEvent(parsed)) continue;
		map.set(parsed.review.id, parsed.review);
	}
	return map;
}

async function appendSnapshot(
	storePath: string,
	record: StoredReviewRecord,
): Promise<void> {
	const event: ReviewSnapshotEvent = {
		type: "review_snapshot",
		version: 1,
		created: new Date().toISOString(),
		review: record,
	};
	await mkdir(path.dirname(storePath), { recursive: true });
	await appendFile(storePath, `${JSON.stringify(event)}\n`, "utf-8");
}

async function withStoreLock<T>(
	storePath: string,
	purpose: string,
	fn: () => Promise<T>,
): Promise<T> {
	const lockPath = `${storePath}.lock`;
	return withFileLock(
		lockPath,
		{ purpose, timeoutMs: 5000, staleMs: 30000 },
		fn,
	);
}

function cloneRecord(record: StoredReviewRecord): StoredReviewRecord {
	return {
		...record,
		request: {
			...record.request,
			files: [...record.request.files],
			warnings: [...record.request.warnings],
		},
		submission: record.submission
			? {
					comments: record.submission.comments.map((comment) => ({
						...comment,
					})),
				}
			: null,
		resultSummary: { ...record.resultSummary },
	};
}

function compareRecords(a: StoredReviewRecord, b: StoredReviewRecord): number {
	const aTs = a.submittedAt ?? a.updatedAt ?? a.createdAt;
	const bTs = b.submittedAt ?? b.updatedAt ?? b.createdAt;
	if (aTs !== bTs) return bTs - aTs;
	return b.createdAt - a.createdAt;
}

export async function createReviewRecord(
	params: {
		id: string;
		request: ReviewRequestRecord;
		createdAt?: number;
	},
	storePath = getReviewStorePath(),
): Promise<StoredReviewRecord> {
	const id = params.id?.trim();
	if (!id) {
		throw new ReviewStoreError("INVALID_INPUT", "Review id is required");
	}

	return withStoreLock(storePath, "review-create", async () => {
		const map = await readSnapshotMap(storePath);
		const existing = map.get(id);
		if (existing) {
			return cloneRecord(existing);
		}

		const createdAt = params.createdAt ?? Date.now();
		const record: StoredReviewRecord = {
			id,
			status: "open",
			createdAt,
			updatedAt: createdAt,
			submittedAt: null,
			cancelledAt: null,
			claimedAt: null,
			claimedBy: null,
			resolvedAt: null,
			resolvedBy: null,
			request: {
				files: [...(params.request.files ?? [])],
				warnings: [...(params.request.warnings ?? [])],
				message: params.request.message,
				cwd: params.request.cwd,
				branch: params.request.branch,
				commit: params.request.commit,
				source: params.request.source,
			},
			submission: null,
			resultSummary: { commentCount: 0 },
		};
		await appendSnapshot(storePath, record);
		return cloneRecord(record);
	});
}

export async function listReviewRecords(
	options: {
		status?: ReviewListStatus;
		claimedBy?: string;
		limit?: number;
	} = {},
	storePath = getReviewStorePath(),
): Promise<StoredReviewRecord[]> {
	const statusFilter = normalizeStatusFilter(options.status);
	const map = await readSnapshotMap(storePath);
	let records = [...map.values()]
		.filter((record) => statusFilter.has(record.status))
		.map(cloneRecord);

	const claimedBy = options.claimedBy?.trim();
	if (claimedBy) {
		records = records.filter((record) => record.claimedBy === claimedBy);
	}

	records.sort(compareRecords);

	if (typeof options.limit === "number" && Number.isFinite(options.limit)) {
		const bounded = Math.max(1, Math.min(Math.floor(options.limit), 200));
		records = records.slice(0, bounded);
	}

	return records;
}

export async function getReviewRecord(
	id: string,
	storePath = getReviewStorePath(),
): Promise<StoredReviewRecord | null> {
	const target = id.trim();
	if (!target) return null;
	const map = await readSnapshotMap(storePath);
	const record = map.get(target);
	return record ? cloneRecord(record) : null;
}

export async function submitReviewRecord(
	id: string,
	comments: ReviewCommentRecord[],
	storePath = getReviewStorePath(),
): Promise<StoredReviewRecord> {
	const target = id.trim();
	if (!target) {
		throw new ReviewStoreError("INVALID_INPUT", "Review id is required");
	}

	return withStoreLock(storePath, "review-submit", async () => {
		const map = await readSnapshotMap(storePath);
		const current = map.get(target);
		if (!current) {
			throw new ReviewStoreError("NOT_FOUND", `Review ${target} not found`);
		}
		if (current.status === "cancelled") {
			throw new ReviewStoreError(
				"INVALID_STATE",
				`Review ${target} is cancelled and cannot be submitted`,
			);
		}
		if (current.status === "resolved") {
			return cloneRecord(current);
		}
		if (current.status === "submitted" || current.status === "claimed") {
			return cloneRecord(current);
		}

		const now = Date.now();
		const normalizedComments = comments.map((comment) => ({
			file: String(comment.file ?? ""),
			startLine: Number(comment.startLine ?? 0),
			endLine: Number(comment.endLine ?? 0),
			selectedText: String(comment.selectedText ?? ""),
			comment: String(comment.comment ?? ""),
		}));

		const updated: StoredReviewRecord = {
			...current,
			status: "submitted",
			updatedAt: now,
			submittedAt: now,
			submission: {
				comments: normalizedComments,
			},
			resultSummary: {
				commentCount: normalizedComments.length,
			},
		};

		await appendSnapshot(storePath, updated);
		return cloneRecord(updated);
	});
}

export async function cancelReviewRecord(
	id: string,
	storePath = getReviewStorePath(),
): Promise<StoredReviewRecord> {
	const target = id.trim();
	if (!target) {
		throw new ReviewStoreError("INVALID_INPUT", "Review id is required");
	}

	return withStoreLock(storePath, "review-cancel", async () => {
		const map = await readSnapshotMap(storePath);
		const current = map.get(target);
		if (!current) {
			throw new ReviewStoreError("NOT_FOUND", `Review ${target} not found`);
		}
		if (current.status === "cancelled") {
			return cloneRecord(current);
		}
		if (
			current.status === "submitted" ||
			current.status === "claimed" ||
			current.status === "resolved"
		) {
			throw new ReviewStoreError(
				"INVALID_STATE",
				`Review ${target} already completed`,
			);
		}

		const now = Date.now();
		const updated: StoredReviewRecord = {
			...current,
			status: "cancelled",
			updatedAt: now,
			cancelledAt: now,
		};
		await appendSnapshot(storePath, updated);
		return cloneRecord(updated);
	});
}

export async function claimReviewRecord(
	id: string,
	claimedBy: string,
	storePath = getReviewStorePath(),
): Promise<StoredReviewRecord> {
	const target = id.trim();
	const actor = claimedBy.trim();
	if (!target) {
		throw new ReviewStoreError("INVALID_INPUT", "Review id is required");
	}
	if (!actor) {
		throw new ReviewStoreError("INVALID_INPUT", "claimedBy is required");
	}

	return withStoreLock(storePath, "review-claim", async () => {
		const map = await readSnapshotMap(storePath);
		const current = map.get(target);
		if (!current) {
			throw new ReviewStoreError("NOT_FOUND", `Review ${target} not found`);
		}
		if (current.status === "resolved") {
			throw new ReviewStoreError(
				"INVALID_STATE",
				`Review ${target} is already resolved`,
			);
		}
		if (current.status === "cancelled" || current.status === "open") {
			throw new ReviewStoreError(
				"INVALID_STATE",
				`Review ${target} is not submit-ready`,
			);
		}
		if (current.status === "claimed") {
			if (current.claimedBy && current.claimedBy !== actor) {
				throw new ReviewStoreError(
					"CONFLICT",
					`Review ${target} is already claimed by ${current.claimedBy}`,
				);
			}
			return cloneRecord(current);
		}

		const now = Date.now();
		const updated: StoredReviewRecord = {
			...current,
			status: "claimed",
			updatedAt: now,
			claimedAt: now,
			claimedBy: actor,
		};
		await appendSnapshot(storePath, updated);
		return cloneRecord(updated);
	});
}

export async function resolveReviewRecord(
	id: string,
	resolvedBy: string | undefined,
	storePath = getReviewStorePath(),
): Promise<StoredReviewRecord> {
	const target = id.trim();
	if (!target) {
		throw new ReviewStoreError("INVALID_INPUT", "Review id is required");
	}

	return withStoreLock(storePath, "review-resolve", async () => {
		const map = await readSnapshotMap(storePath);
		const current = map.get(target);
		if (!current) {
			throw new ReviewStoreError("NOT_FOUND", `Review ${target} not found`);
		}
		if (current.status === "resolved") {
			return cloneRecord(current);
		}
		if (current.status === "open" || current.status === "cancelled") {
			throw new ReviewStoreError(
				"INVALID_STATE",
				`Review ${target} is not submitted`,
			);
		}

		const now = Date.now();
		const updated: StoredReviewRecord = {
			...current,
			status: "resolved",
			updatedAt: now,
			resolvedAt: now,
			resolvedBy: resolvedBy?.trim() || current.resolvedBy,
		};
		await appendSnapshot(storePath, updated);
		return cloneRecord(updated);
	});
}
