import { randomUUID } from "node:crypto";
import path from "node:path";
import { spawn } from "node-pty";

export interface PtyHandle {
	pid: number;
	write(data: string): void;
	resize(cols: number, rows: number): void;
	kill(signal?: string): void;
	onData(listener: (data: string) => void): { dispose(): void };
	onExit(listener: (event: { exitCode: number; signal?: number }) => void): {
		dispose(): void;
	};
}

export interface CreateTerminalSessionOptions {
	cols?: number;
	rows?: number;
}

export interface TerminalSessionInfo {
	id: string;
	shell: string;
	cwd: string;
	cols: number;
	rows: number;
	pid: number | null;
	startedAt: string;
	lastActivityAt: string;
}

export interface TerminalManagerOptions {
	idleTtlMs?: number;
	historyLimitBytes?: number;
}

export type TerminalSessionEvent =
	| {
			type: "data";
			sessionId: string;
			data: string;
	  }
	| {
			type: "exit";
			sessionId: string;
			exitCode: number | null;
			signal: number | null;
	  };

export type TerminalSessionSubscriber = (event: TerminalSessionEvent) => void;

export type PtyFactory = (
	shell: string,
	args: string[],
	options: {
		name: string;
		cols: number;
		rows: number;
		cwd: string;
		env: NodeJS.ProcessEnv;
	},
) => PtyHandle;

type HistoryChunk = { data: string; bytes: number };

type ManagedSession = {
	info: TerminalSessionInfo;
	pty: PtyHandle;
	subscribers: Set<TerminalSessionSubscriber>;
	dataSubscription: { dispose(): void };
	exitSubscription: { dispose(): void };
	history: HistoryChunk[];
	historyHead: number;
	historyLen: number;
	historyBytes: number;
	lastActivityMs: number;
	closeTimer: NodeJS.Timeout | null;
	closed: boolean;
};

const DEFAULT_IDLE_TTL_MS = 5 * 60_000;
const DEFAULT_HISTORY_LIMIT_BYTES = 2 * 1024 * 1024;

function resolveDefaultShell(): string {
	if (process.platform === "win32") {
		return process.env.COMSPEC?.trim() || "powershell.exe";
	}
	return process.env.SHELL?.trim() || "bash";
}

function clampDimension(value: number | undefined, fallback: number): number {
	if (!Number.isFinite(value)) {
		return fallback;
	}
	const next = Math.floor(Number(value));
	return Math.max(2, Math.min(next, 500));
}

function normalizeIdleTtlMs(value: number | undefined): number {
	if (!Number.isFinite(value)) {
		return DEFAULT_IDLE_TTL_MS;
	}
	return Math.max(10, Math.floor(Number(value)));
}

function normalizeHistoryLimitBytes(value: number | undefined): number {
	if (!Number.isFinite(value)) {
		return DEFAULT_HISTORY_LIMIT_BYTES;
	}
	return Math.max(32 * 1024, Math.floor(Number(value)));
}

function defaultPtyFactory(
	shell: string,
	args: string[],
	options: {
		name: string;
		cols: number;
		rows: number;
		cwd: string;
		env: NodeJS.ProcessEnv;
	},
): PtyHandle {
	return spawn(shell, args, options);
}

export class TerminalManager {
	private sessions = new Map<string, ManagedSession>();
	private readonly ptyFactory: PtyFactory;
	private readonly idleTtlMs: number;
	private readonly historyLimitBytes: number;

	constructor(
		ptyFactory: PtyFactory = defaultPtyFactory,
		options: TerminalManagerOptions = {},
	) {
		this.ptyFactory = ptyFactory;
		this.idleTtlMs = normalizeIdleTtlMs(options.idleTtlMs);
		this.historyLimitBytes = normalizeHistoryLimitBytes(
			options.historyLimitBytes,
		);
	}

	createSession(
		options: CreateTerminalSessionOptions = {},
	): TerminalSessionInfo {
		const cols = clampDimension(options.cols, 120);
		const rows = clampDimension(options.rows, 32);
		const cwd = path.resolve(process.cwd());
		const shell = resolveDefaultShell();
		const now = Date.now();
		const nowIso = new Date(now).toISOString();
		const info: TerminalSessionInfo = {
			id: randomUUID(),
			shell,
			cwd,
			cols,
			rows,
			pid: null,
			startedAt: nowIso,
			lastActivityAt: nowIso,
		};
		const pty = this.ptyFactory(shell, [], {
			name: "xterm-256color",
			cols,
			rows,
			cwd,
			env: {
				...process.env,
				TERM: "xterm-256color",
				COLORTERM: "truecolor",
			},
		});
		info.pid = Number.isFinite(pty.pid) ? pty.pid : null;

		const session: ManagedSession = {
			info,
			pty,
			subscribers: new Set(),
			dataSubscription: pty.onData((data) => {
				const active = this.sessions.get(info.id);
				if (!active || active.closed) {
					return;
				}
				active.lastActivityMs = Date.now();
				this.appendHistory(active, data);
				this.emit(active, {
					type: "data",
					sessionId: active.info.id,
					data,
				});
			}),
			exitSubscription: pty.onExit((event) => {
				this.finalizeSession(info.id, {
					type: "exit",
					sessionId: info.id,
					exitCode: typeof event.exitCode === "number" ? event.exitCode : null,
					signal: typeof event.signal === "number" ? event.signal : null,
				});
			}),
			history: [],
			historyHead: 0,
			historyLen: 0,
			historyBytes: 0,
			lastActivityMs: now,
			closeTimer: null,
			closed: false,
		};

		this.sessions.set(info.id, session);
		this.scheduleClose(session);
		return { ...info };
	}

	private snapshotInfo(session: ManagedSession): TerminalSessionInfo {
		return {
			...session.info,
			lastActivityAt: new Date(session.lastActivityMs).toISOString(),
		};
	}

	listSessions(): TerminalSessionInfo[] {
		return Array.from(this.sessions.values(), (session) =>
			this.snapshotInfo(session),
		);
	}

	getSession(sessionId: string): TerminalSessionInfo | null {
		const session = this.sessions.get(sessionId);
		return session ? this.snapshotInfo(session) : null;
	}

	getReplay(sessionId: string): string {
		const session = this.requireSession(sessionId);
		const { history, historyHead, historyLen } = session;
		if (historyLen === 0) return "";
		const cap = history.length;
		const parts: string[] = new Array(historyLen);
		for (let i = 0; i < historyLen; i++) {
			parts[i] = history[(historyHead + i) % cap].data;
		}
		return parts.join("");
	}

	subscribe(
		sessionId: string,
		subscriber: TerminalSessionSubscriber,
	): () => void {
		const session = this.requireSession(sessionId);
		this.cancelCloseTimer(session);
		session.subscribers.add(subscriber);
		return () => {
			session.subscribers.delete(subscriber);
			if (session.subscribers.size === 0) {
				this.scheduleClose(session);
			}
		};
	}

	write(sessionId: string, data: string): void {
		if (typeof data !== "string" || data.length === 0) {
			return;
		}
		const session = this.requireSession(sessionId);
		session.lastActivityMs = Date.now();
		session.pty.write(data);
	}

	resize(sessionId: string, cols: number, rows: number): TerminalSessionInfo {
		const session = this.requireSession(sessionId);
		const nextCols = clampDimension(cols, session.info.cols);
		const nextRows = clampDimension(rows, session.info.rows);
		session.pty.resize(nextCols, nextRows);
		session.info.cols = nextCols;
		session.info.rows = nextRows;
		session.lastActivityMs = Date.now();
		return this.snapshotInfo(session);
	}

	close(sessionId: string): boolean {
		const session = this.sessions.get(sessionId);
		if (!session) {
			return false;
		}
		this.finalizeSession(sessionId, {
			type: "exit",
			sessionId,
			exitCode: null,
			signal: 15,
		});
		try {
			session.pty.kill();
		} catch {
			// Ignore kill failures during cleanup.
		}
		return true;
	}

	dispose(): void {
		for (const sessionId of Array.from(this.sessions.keys())) {
			this.close(sessionId);
		}
	}

	private requireSession(sessionId: string): ManagedSession {
		const normalized = sessionId.trim();
		if (!normalized) {
			throw new Error("Terminal session id is required");
		}
		const session = this.sessions.get(normalized);
		if (!session) {
			throw new Error(`Unknown terminal session: ${normalized}`);
		}
		return session;
	}

	private emit(session: ManagedSession, event: TerminalSessionEvent): void {
		for (const subscriber of session.subscribers) {
			try {
				subscriber(event);
			} catch {
				// Ignore subscriber failures so one bad socket doesn't break the session.
			}
		}
	}

	private appendHistory(session: ManagedSession, data: string): void {
		const bytes = Buffer.byteLength(data, "utf8");
		const chunk: HistoryChunk = { data, bytes };
		const cap = session.history.length;

		if (session.historyLen < cap) {
			// Ring buffer not yet full — fill next slot.
			const idx = (session.historyHead + session.historyLen) % cap;
			session.history[idx] = chunk;
			session.historyLen++;
		} else {
			// Grow or overwrite. For simplicity, push and let eviction trim.
			session.history.push(chunk);
			session.historyLen++;
		}
		session.historyBytes += bytes;

		// Evict oldest chunks from the head until within budget.
		while (
			session.historyLen > 1 &&
			session.historyBytes > this.historyLimitBytes
		) {
			const oldest = session.history[session.historyHead];
			session.historyBytes -= oldest.bytes;
			session.history[session.historyHead] =
				undefined as unknown as HistoryChunk;
			session.historyHead = (session.historyHead + 1) % session.history.length;
			session.historyLen--;
		}
	}

	private scheduleClose(session: ManagedSession): void {
		if (session.closed || session.closeTimer) {
			return;
		}
		session.closeTimer = setTimeout(() => {
			session.closeTimer = null;
			this.close(session.info.id);
		}, this.idleTtlMs);
	}

	private cancelCloseTimer(session: ManagedSession): void {
		if (!session.closeTimer) {
			return;
		}
		clearTimeout(session.closeTimer);
		session.closeTimer = null;
	}

	private finalizeSession(
		sessionId: string,
		event: TerminalSessionEvent,
	): void {
		const session = this.sessions.get(sessionId);
		if (!session || session.closed) {
			return;
		}
		session.closed = true;
		session.lastActivityMs = Date.now();
		this.cancelCloseTimer(session);
		this.emit(session, event);
		session.dataSubscription.dispose();
		session.exitSubscription.dispose();
		session.subscribers.clear();
		this.sessions.delete(sessionId);
	}
}

export const terminalManager = new TerminalManager();
