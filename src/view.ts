// The wire view: what a client is shown of a conversation, and nothing else. The daemon's
// event stream sends this whole object on every change, so a client that reconnects simply
// takes the newest one. Storage paths, system prompts and bookkeeping entries stay out.
import type { Message } from "@earendil-works/pi-ai";
import type { ConversationView, EntryRecord } from "@earendil-works/pi-durable";
import type { ReleaseView } from "./gate.ts";

export interface ToolCallView {
	id: string;
	name: string;
	/** Why the model made the call, in its own short phrase; absent when it gave none. */
	reasoning?: string;
	/** The call's arguments, without `reasoning`. */
	args: Record<string, unknown>;
}
export type EntryView =
	| { id: number; role: "user"; text: string; /** How many photos came with it. The pictures are not in the view: a client asks for each (`GET /api/image`). */ images?: number }
	| { id: number; role: "assistant"; text: string; calls: ToolCallView[]; model?: string; cut?: true }
	| { id: number; role: "tool"; callId: string; name: string; text: string; /** The result in a few words. */ summary: string; /** What an edit changed. */ diff?: string; error?: true; /** How long it ran, in milliseconds, when the engine measured it. */ ms?: number }
	| { id: number; role: "notice"; text: string; /** Who sent it: "gate", "check-in". */ from: string }
	| { id: number; role: "divider"; text: string };

/** A worker as a client is shown it. The job line is the agent's words; `step` names a tool and what it acts on. */
export interface WorkerView {
	id: string;
	title: string;
	/** Where it runs. */
	place: string;
	/** The model it runs on, `provider/id`, and whether the agent chose it for the job. */
	model?: string;
	picked?: boolean;
	status: "waiting" | "working" | "asking" | "done" | "partial" | "failed" | "stopped";
	createdAt: number;
	startedAt?: number;
	endedAt?: number;
	/** Its own thread, to open and read, once it has one. */
	conversation?: string;
	/** What it is doing now: the tool and its target, as a tool card names them. */
	step?: string;
}
export interface StateView {
	conversation: string;
	entries: EntryView[];
	/** Older entries exist before this window. */
	more: boolean;
	running: boolean;
	/** The answer so far, while one is being written. */
	partial: string;
	/** Tools of the current round, with the output they have produced so far. */
	tools: { id: string; name: string; status: "pending" | "running" | "done"; output: string }[];
	retry?: { at: number; attempt: number; error: string };
	queued: { id: string; mode: "steer" | "followUp"; text: string; images?: number }[];
	failure?: { reason: string; text: string; detail?: string };
	model?: string;
	thinking?: string;
	/** Commands that wait for the person's yes. */
	approvals: { id: string; tool: string; command: string; what: string; /** What it would do, in lines. */ details?: string[]; /** The worker that asks, when it is not the agent itself: its id and job. */ worker?: string }[];
	/** Workers this conversation handed jobs to: live ones, and those that ended in the last day. */
	workers?: WorkerView[];
	/** Set when this is a worker's own thread, which is read only: whose it is and where to go back to. */
	workerThread?: { id: string; title: string; from: string };
	/** The directory this conversation's tools work in. */
	cwd?: string;
	/** A release of new code into rho that is under way, or one that ended in the last few minutes. */
	release?: ReleaseView;
	/** What the person must do before this conversation's model can answer; absent when it can. */
	setup?: string;
}

type Content = Message["content"];
export function textOf(content: Content | undefined): string {
	if (typeof content === "string") return content;
	return (content ?? []).map((part) => (part.type === "text" ? part.text : "")).join("");
}

/** How many pictures a message carries. */
export function imagesOf(content: Content | undefined): number {
	return typeof content === "string" ? 0 : (content ?? []).filter((part) => part.type === "image").length;
}
const photos = (content: Content | undefined): { images?: number } => (imagesOf(content) > 0 ? { images: imagesOf(content) } : {});

const FAILURES: Record<string, string> = {
	model_error: "The model call failed.",
	no_model: "That model is not available.",
	aborted: "Stopped.",
	interrupted: "Rho was restarted too many times while answering.",
	restart_limit: "Rho was restarted too many times while answering.",
	faulted: "The run could not go on.",
	orphaned: "The run could not go on.",
	turn_limit: "The run reached its step limit.",
};

const firstLine = (text: string): string => (text.trim().split("\n")[0] ?? "").slice(0, 100);
/** A tool result in a few words, for the second line of its card. */
export function summarize(text: string, isError: boolean, diff?: string): string {
	// The harness wraps its own error notes in a <harness> block; the words inside are the summary.
	if (isError) return firstLine(text.split("\n").filter((line) => !/^<\/?harness>$/.test(line.trim())).join("\n").replace(/^\s*\[error\]\s*/, "")) || "failed";
	if (diff !== undefined) {
		const lines = diff.split("\n");
		const count = (mark: string) => lines.filter((line) => line.startsWith(mark) && !line.startsWith(mark.repeat(3))).length;
		return `+${count("+")} −${count("-")}`;
	}
	const lines = text.trimEnd().split("\n");
	if (text.trim() === "") return "no output";
	return lines.length === 1 ? firstLine(text) : `${lines.length} lines`;
}

export function entryView(entry: EntryRecord): EntryView | undefined {
	const id = Number(entry.id);
	const message = entry.model?.[0];
	if (entry.kind === "pi.user" && message?.role === "user") return { id, role: "user", text: textOf(message.content), ...photos(message.content) };
	if (entry.kind === "pi.assistant" && message?.role === "assistant") {
		const calls = message.content.flatMap((part) => {
			if (part.type !== "toolCall") return [];
			const { reasoning, ...args } = part.arguments as Record<string, unknown>;
			return [{ id: part.id, name: part.name, ...(typeof reasoning === "string" && reasoning.trim() !== "" ? { reasoning: reasoning.trim().slice(0, 200) } : {}), args }];
		});
		const cut = message.stopReason === "aborted" || message.stopReason === "error";
		return { id, role: "assistant", text: textOf(message.content), calls, model: message.model, ...(cut ? { cut: true as const } : {}) };
	}
	if (entry.kind === "pi.tool-result" && message?.role === "toolResult") {
		const text = textOf(message.content);
		const details = message.details as { diff?: unknown } | undefined;
		const diff = typeof details?.diff === "string" ? details.diff : undefined;
		return { id, role: "tool", callId: message.toolCallId, name: message.toolName, text, summary: summarize(text, message.isError, diff), ...(diff !== undefined ? { diff } : {}), ...(message.isError ? { error: true as const } : {}), ...(typeof message.durationMs === "number" ? { ms: Math.round(message.durationMs) } : {}) };
	}
	if (entry.kind === "rho.notice") return { id, role: "notice", text: textOf(message?.content), from: String((entry.data as { from?: unknown } | undefined)?.from ?? "rho") };
	if (entry.kind === "pi.reset") return { id, role: "divider", text: "Context cleared" };
	if (entry.kind === "pi.compaction") return { id, role: "divider", text: "Earlier messages were summarized" };
	return undefined;
}

interface Live {
	run?: object;
	generation?: { attempt: number; message?: { content?: Content }; retry?: { at: number; error: string } };
	tools?: { callId: string; name: string; status: "pending" | "running" | "done"; output?: string }[];
	runFailure?: { reason: string; detail?: string };
}
interface Inbox { items?: ({ id: unknown; mode: "steer" | "followUp"; content: { content?: Content } | Content } | { id: unknown; mode: "write" })[] }
interface AgentDoc { model?: { provider: string; modelId: string }; thinkingLevel?: string; cwd?: string }

export function stateView(view: ConversationView, approvals: StateView["approvals"] = []): StateView {
	const live = (view.docs["pi.live"] ?? {}) as Live;
	const inbox = (view.docs["pi.inbox"] ?? {}) as Inbox;
	const agent = (view.docs["pi.agent"] ?? {}) as AgentDoc;
	const failure = live.runFailure;
	const retry = live.generation?.retry;
	return {
		conversation: String(view.conversation.id),
		entries: view.entries.flatMap((entry) => entryView(entry) ?? []),
		more: view.before !== undefined,
		running: live.run !== undefined,
		partial: textOf(live.generation?.message?.content),
		tools: (live.tools ?? []).map((tool) => ({ id: tool.callId, name: tool.name, status: tool.status, output: tool.output ?? "" })),
		...(retry ? { retry: { at: retry.at, attempt: live.generation!.attempt, error: retry.error.slice(0, 300) } } : {}),
		queued: (inbox.items ?? []).flatMap((item) => {
			if (item.mode === "write") return [];
			const content = item.content as { content?: Content } | Content;
			const said = typeof content === "object" && content !== null && !Array.isArray(content) && "content" in content ? content.content : (content as Content);
			return [{ id: String(item.id), mode: item.mode, text: textOf(said), ...photos(said) }];
		}),
		...(failure && failure.reason !== "reset" && failure.reason !== "nothing_to_answer" ? { failure: { reason: failure.reason, text: FAILURES[failure.reason] ?? "The run ended without an answer.", ...(failure.detail ? { detail: failure.detail.slice(0, 300) } : {}) } } : {}),
		approvals,
		...(agent.model ? { model: `${agent.model.provider}/${agent.model.modelId}` } : {}),
		...(agent.thinkingLevel ? { thinking: agent.thinkingLevel } : {}),
		...(agent.cwd ? { cwd: agent.cwd } : {}),
	};
}
