import os from "node:os";
import path from "node:path";

export interface SessionSummary {
	id: string;
	file: string;
	name?: string;
	firstPrompt?: string;
	cwd: string;
	timestamp: string;
	parentSession?: string;
	messageCount: number;
	lastMessage?: string;
	isActive: boolean;
}

export interface SessionHeader {
	type: "session";
	version?: number;
	id: string;
	timestamp?: string;
	cwd?: string;
	parentSession?: string;
}

export interface ParsedMessage {
	id: string;
	parentId: string | null;
	role: string;
	content: unknown;
	timestamp: string;
	usage?: Record<string, unknown>;
	model?: string;
}

export interface ForkPoint {
	id: string;
	text: string;
	timestamp: string;
}

export interface ParsedSession {
	header: SessionHeader;
	file?: string;
	messages: ParsedMessage[];
	forkPoints: ForkPoint[];
	stats: { messageCount: number; tokenUsage: number; cost: number };
	name?: string;
}

export interface SessionEntryBase {
	type: string;
	id?: string;
	parentId?: string | null;
	timestamp?: string;
}

export interface MessageEntry extends SessionEntryBase {
	type: "message";
	message: {
		role?: string;
		content?: unknown;
		timestamp?: number | string;
		usage?: Record<string, unknown>;
		model?: string;
		modelId?: string;
	};
}

export interface CompactionEntry extends SessionEntryBase {
	type: "compaction";
	summary?: string;
	firstKeptEntryId?: string;
	tokensBefore?: number;
	details?: Record<string, unknown>;
}

export interface BranchSummaryEntry extends SessionEntryBase {
	type: "branch_summary";
	summary?: string;
	fromId?: string;
	details?: Record<string, unknown>;
}

export interface CustomMessageEntry extends SessionEntryBase {
	type: "custom_message";
	content?: unknown;
	customType?: string;
	display?: boolean;
	details?: Record<string, unknown>;
}

export interface SessionInfoEntry extends SessionEntryBase {
	type: "session_info";
	name?: string;
}

export interface LabelEntry extends SessionEntryBase {
	type: "label";
	targetId?: string;
	label?: string;
}

export type SessionInfo = {
	id: string;
	cwd: string;
	timestamp: string;
	parentSession?: string;
	name?: string;
	firstPrompt?: string;
	messageCount: number;
	lastMessage?: string;
};

export const DEFAULT_SESSION_DIR = path.join(
	os.homedir(),
	".pi",
	"agent",
	"sessions",
);
