import { Type } from "@sinclair/typebox";
import { resolveFiles } from "./files.ts";
import { formatReviewMessage } from "./format.ts";
import { setupGitTracker } from "./git-tracker.ts";
import {
	createReviewSession,
	DEFAULT_RHO_WEB,
	ensureRhoWebRunning,
	type ReviewComment,
	type ReviewResult,
	startReviewServer,
} from "./server.ts";

/**
 * Parse a command argument string into individual tokens.
 * Supports double-quoted, single-quoted, and bare-word arguments.
 */
export function parseArgs(input: string): string[] {
	const args: string[] = [];
	let i = 0;
	const src = input.trim();

	while (i < src.length) {
		while (i < src.length && src[i] === " ") i++;
		if (i >= src.length) break;

		const quote = src[i];
		if (quote === '"' || quote === "'") {
			i++;
			let token = "";
			while (i < src.length && src[i] !== quote) {
				token += src[i];
				i++;
			}
			i++;
			args.push(token);
		} else {
			let token = "";
			while (i < src.length && src[i] !== " ") {
				token += src[i];
				i++;
			}
			args.push(token);
		}
	}

	return args;
}

type ReviewInboxAction = "list" | "get" | "claim" | "resolve";

type ReviewInboxRecord = {
	id: string;
	status: string;
	createdAt: number;
	updatedAt: number;
	submittedAt: number | null;
	claimedAt: number | null;
	claimedBy: string | null;
	resolvedAt: number | null;
	resolvedBy: string | null;
	fileCount: number;
	files: string[];
	message: string | null;
	commentCount: number;
	submission?: {
		comments?: ReviewComment[];
	};
};

function reviewApiBaseUrl(): string {
	return process.env.RHO_REVIEW_BASE_URL ?? DEFAULT_RHO_WEB;
}

async function reviewApiFetch(
	path: string,
	init?: RequestInit,
): Promise<Response> {
	const baseUrl = reviewApiBaseUrl();
	await ensureRhoWebRunning(baseUrl);
	return fetch(`${baseUrl}${path}`, init);
}

function formatInboxList(records: ReviewInboxRecord[]): string {
	if (records.length === 0) {
		return "No submitted reviews found.";
	}

	const lines: string[] = ["## Review Inbox"];
	for (const record of records) {
		const when = record.submittedAt ?? record.updatedAt ?? record.createdAt;
		const timestamp = new Date(when).toISOString();
		const claim = record.claimedBy ? ` · claimed by ${record.claimedBy}` : "";
		lines.push(
			`- [${record.id}] ${record.status} · ${record.commentCount} comment${record.commentCount !== 1 ? "s" : ""} · ${record.files.join(", ")} · ${timestamp}${claim}`,
		);
	}
	lines.push("", "Use review_inbox get with an id to retrieve full comments.");
	return lines.join("\n");
}

export default function reviewExtension(pi: any) {
	setupGitTracker(pi);

	pi.registerTool({
		name: "review",
		description:
			"Open files for user review with line-level commenting. Always deferred: returns review id + URL immediately.",
		parameters: Type.Object({
			files: Type.Array(Type.String(), {
				description: "File paths to open for review",
			}),
			message: Type.Optional(
				Type.String({
					description: "Optional context message shown to the reviewer",
				}),
			),
		}),
		execute: async (
			_toolCallId: string,
			params: { files: string[]; message?: string },
			_signal: AbortSignal | undefined,
			_onUpdate: any,
			ctx: any,
		) => {
			if (ctx?.hasUI === false) {
				return {
					content: [
						{
							type: "text",
							text: "Error: review tool requires interactive mode (a browser).",
						},
					],
				};
			}

			const cwd = pi.cwd ?? process.cwd();
			const { files, warnings } = await resolveFiles(params.files, cwd);

			if (files.length === 0) {
				return {
					content: [
						{
							type: "text",
							text: "No files found matching the provided paths.",
						},
					],
				};
			}

			const created = await createReviewSession({
				files,
				warnings,
				message: params.message,
				onReady: (url: string) => {
					ctx?.ui?.notify?.(`Review ready: ${url}`, "info");
				},
			});

			const text = [
				"Review requested (deferred).",
				`review_id: ${created.id}`,
				`url: ${created.url}`,
				"When the user submits, use review_inbox list/get to retrieve comments.",
			].join("\n");
			return { content: [{ type: "text", text }] };
		},
	});

	pi.registerTool({
		name: "review_inbox",
		description:
			"Manage deferred review submissions. Actions: list, get, claim, resolve.",
		parameters: Type.Object({
			action: Type.Union([
				Type.Literal("list"),
				Type.Literal("get"),
				Type.Literal("claim"),
				Type.Literal("resolve"),
			]),
			id: Type.Optional(
				Type.String({ description: "Review id for get/claim/resolve" }),
			),
			status: Type.Optional(
				Type.Union([
					Type.Literal("inbox"),
					Type.Literal("submitted"),
					Type.Literal("claimed"),
					Type.Literal("resolved"),
					Type.Literal("cancelled"),
					Type.Literal("open"),
					Type.Literal("all"),
				]),
			),
			claimedBy: Type.Optional(
				Type.String({ description: "Claim owner filter for list" }),
			),
			actor: Type.Optional(
				Type.String({
					description: "Actor identity for claim/resolve updates",
				}),
			),
			limit: Type.Optional(
				Type.Number({ description: "Max records for list" }),
			),
		}),
		execute: async (
			_toolCallId: string,
			params: {
				action: ReviewInboxAction;
				id?: string;
				status?:
					| "inbox"
					| "submitted"
					| "claimed"
					| "resolved"
					| "cancelled"
					| "open"
					| "all";
				claimedBy?: string;
				actor?: string;
				limit?: number;
			},
		) => {
			if (params.action === "list") {
				const query = new URLSearchParams();
				if (params.status) query.set("status", params.status);
				if (params.claimedBy) query.set("claimedBy", params.claimedBy);
				if (typeof params.limit === "number") {
					query.set("limit", String(params.limit));
				}

				const suffix = query.toString() ? `?${query.toString()}` : "";
				const res = await reviewApiFetch(`/api/review/submissions${suffix}`);
				if (!res.ok) {
					const text = await res.text();
					return {
						content: [
							{
								type: "text",
								text: `Failed to list review inbox (${res.status}): ${text}`,
							},
						],
					};
				}

				const records = (await res.json()) as ReviewInboxRecord[];
				return {
					content: [{ type: "text", text: formatInboxList(records) }],
				};
			}

			if (!params.id?.trim()) {
				return {
					content: [
						{
							type: "text",
							text: `Error: id is required for action ${params.action}.`,
						},
					],
				};
			}

			const id = params.id.trim();

			if (params.action === "get") {
				const res = await reviewApiFetch(
					`/api/review/submissions/${encodeURIComponent(id)}`,
				);
				if (res.status === 404) {
					return {
						content: [{ type: "text", text: `Review ${id} not found.` }],
					};
				}
				if (!res.ok) {
					return {
						content: [
							{
								type: "text",
								text: `Failed to fetch review ${id} (${res.status}).`,
							},
						],
					};
				}

				const record = (await res.json()) as ReviewInboxRecord;
				const comments = record.submission?.comments ?? [];
				if (!Array.isArray(comments) || comments.length === 0) {
					return {
						content: [
							{
								type: "text",
								text: `Review ${id} has no submitted comments (status: ${record.status}).`,
							},
						],
					};
				}
				const formatted = formatReviewMessage(comments);
				return { content: [{ type: "text", text: formatted }] };
			}

			if (params.action === "claim") {
				const res = await reviewApiFetch(
					`/api/review/submissions/${encodeURIComponent(id)}/claim`,
					{
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ claimedBy: params.actor ?? "agent" }),
					},
				);
				const payload = await res.json().catch(() => null);
				if (!res.ok) {
					return {
						content: [
							{
								type: "text",
								text: payload?.error ?? `Failed to claim review ${id}.`,
							},
						],
					};
				}
				return {
					content: [
						{
							type: "text",
							text: `Claimed review ${id} (${payload?.status ?? "claimed"}).`,
						},
					],
				};
			}

			const res = await reviewApiFetch(
				`/api/review/submissions/${encodeURIComponent(id)}/resolve`,
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ resolvedBy: params.actor ?? "agent" }),
				},
			);
			const payload = await res.json().catch(() => null);
			if (!res.ok) {
				return {
					content: [
						{
							type: "text",
							text: payload?.error ?? `Failed to resolve review ${id}.`,
						},
					],
				};
			}
			return {
				content: [{ type: "text", text: `Resolved review ${id}.` }],
			};
		},
	});

	pi.registerCommand("review", {
		description: "Review files with line-by-line commenting",
		handler: async (args: string, ctx?: any) => {
			const paths = parseArgs(args);
			const isTUI = paths.includes("--tui");
			const filteredPaths = paths.filter((p) => p !== "--tui");

			if (filteredPaths.length === 0) {
				ctx?.ui?.notify?.("Usage: /review [--tui] <file|glob|dir> ...", "info");
				return;
			}

			const cwd = pi.cwd ?? process.cwd();
			const { files, warnings } = await resolveFiles(filteredPaths, cwd);

			if (files.length === 0) {
				ctx?.ui?.notify?.(
					"No files found matching the given paths.",
					"warning",
				);
				return;
			}

			if (warnings.length > 0) {
				ctx?.ui?.notify?.(
					`⚠ ${warnings.length} file(s) skipped — see review UI for details`,
					"warning",
				);
			}

			ctx?.ui?.notify?.(
				`Opening review for ${files.length} file(s)...`,
				"info",
			);

			if (isTUI) {
				ctx?.ui?.setStatus?.("review", "📝 Review in progress...");
				try {
					const { startTUIReview } = await import("./tui.ts");
					const result: ReviewResult = await startTUIReview(ctx, {
						files,
						warnings,
					});
					if (result.cancelled) {
						ctx?.ui?.notify?.("Review cancelled.", "info");
					} else if (result.comments.length > 0) {
						const message = formatReviewMessage(result.comments);
						pi.sendUserMessage(message);
					}
					return result;
				} finally {
					ctx?.ui?.clearStatus?.("review");
				}
			}

			const created = await createReviewSession({
				files,
				warnings,
				onReady: (url) => {
					ctx?.ui?.notify?.(`Review ready: ${url}`);
				},
			});

			ctx?.ui?.notify?.(`Review queued (deferred): ${created.id}`, "info");
			return { deferred: true, ...created };
		},
	});
}
