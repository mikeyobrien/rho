import type { RPCEvent } from "./rpc-manager.ts";

export type BufferedRPCEvent = {
	seq: number;
	event: RPCEvent;
	timestamp: number;
};

export type ReplayResult = {
	events: BufferedRPCEvent[];
	gap: boolean;
	oldestSeq: number;
	latestSeq: number;
};

export type RegisterCommandResult = {
	duplicate: boolean;
	cachedResponse?: RPCEvent;
	cachedResponseSeq?: number;
};

export type RpcSessionReliabilityOptions = {
	eventBufferSize?: number;
	commandRetentionMs?: number;
	orphanGraceMs?: number;
	orphanAbortDelayMs?: number;
	now?: () => number;
	hasSubscribers?: (sessionId: string) => boolean;
	onAbort?: (sessionId: string) => void;
	onStop?: (sessionId: string) => void;
	setTimeoutFn?: typeof setTimeout;
	clearTimeoutFn?: typeof clearTimeout;
};

type SessionReliabilityState = {
	nextSeq: number;
	events: BufferedRPCEvent[];
	seenCommandIds: Map<string, number>;
	responseByCommandId: Map<string, { event: RPCEvent; seq: number }>;
	orphanTimer: NodeJS.Timeout | null;
	orphanStopTimer: NodeJS.Timeout | null;
};

const DEFAULT_EVENT_BUFFER_SIZE = 800;
const DEFAULT_COMMAND_RETENTION_MS = 5 * 60_000;
const DEFAULT_ORPHAN_GRACE_MS = 60_000;
const DEFAULT_ORPHAN_ABORT_DELAY_MS = 5_000;

function isResponseEvent(event: RPCEvent): event is RPCEvent & { id: string } {
	return (
		event &&
		typeof event === "object" &&
		event.type === "response" &&
		typeof event.id === "string" &&
		event.id.length > 0
	);
}

export class RpcSessionReliability {
	private readonly eventBufferSize: number;
	private readonly commandRetentionMs: number;
	private readonly orphanGraceMs: number;
	private readonly orphanAbortDelayMs: number;
	private readonly now: () => number;
	private readonly hasSubscribers: (sessionId: string) => boolean;
	private readonly onAbort: (sessionId: string) => void;
	private readonly onStop: (sessionId: string) => void;
	private readonly setTimeoutFn: typeof setTimeout;
	private readonly clearTimeoutFn: typeof clearTimeout;
	private readonly sessions = new Map<string, SessionReliabilityState>();

	constructor(options: RpcSessionReliabilityOptions = {}) {
		this.eventBufferSize = Math.max(
			1,
			options.eventBufferSize ?? DEFAULT_EVENT_BUFFER_SIZE,
		);
		this.commandRetentionMs = Math.max(
			1,
			options.commandRetentionMs ?? DEFAULT_COMMAND_RETENTION_MS,
		);
		this.orphanGraceMs = Math.max(
			1,
			options.orphanGraceMs ?? DEFAULT_ORPHAN_GRACE_MS,
		);
		this.orphanAbortDelayMs = Math.max(
			0,
			options.orphanAbortDelayMs ?? DEFAULT_ORPHAN_ABORT_DELAY_MS,
		);
		this.now = options.now ?? (() => Date.now());
		this.hasSubscribers = options.hasSubscribers ?? (() => false);
		this.onAbort = options.onAbort ?? (() => {});
		this.onStop = options.onStop ?? (() => {});
		this.setTimeoutFn = options.setTimeoutFn ?? setTimeout;
		this.clearTimeoutFn = options.clearTimeoutFn ?? clearTimeout;
	}

	recordEvent(sessionId: string, event: RPCEvent): number {
		const state = this.getOrCreateState(sessionId);
		const seq = state.nextSeq++;
		const buffered: BufferedRPCEvent = {
			seq,
			event,
			timestamp: this.now(),
		};
		state.events.push(buffered);

		if (state.events.length > this.eventBufferSize) {
			state.events.splice(0, state.events.length - this.eventBufferSize);
		}

		if (isResponseEvent(event)) {
			state.responseByCommandId.set(event.id, { event, seq });
			state.seenCommandIds.set(event.id, this.now());
		}

		this.pruneCommandState(state);
		return seq;
	}

	getReplay(sessionId: string, lastSeenSeq: number): ReplayResult {
		const state = this.sessions.get(sessionId);
		if (!state || state.events.length === 0) {
			return {
				events: [],
				gap: false,
				oldestSeq: 0,
				latestSeq: 0,
			};
		}

		const oldestSeq = state.events[0].seq;
		const latestSeq = state.events[state.events.length - 1].seq;
		const normalizedLastSeen = Number.isFinite(lastSeenSeq)
			? Math.max(0, Math.floor(lastSeenSeq))
			: 0;
		const gap = normalizedLastSeen < oldestSeq - 1;
		const events = gap
			? [...state.events]
			: state.events.filter((entry) => entry.seq > normalizedLastSeen);

		return {
			events,
			gap,
			oldestSeq,
			latestSeq,
		};
	}

	registerCommand(sessionId: string, commandId: string): RegisterCommandResult {
		const trimmedId = commandId.trim();
		if (!trimmedId) {
			return { duplicate: false };
		}

		const state = this.getOrCreateState(sessionId);
		this.pruneCommandState(state);

		const cached = state.responseByCommandId.get(trimmedId);
		if (cached) {
			state.seenCommandIds.set(trimmedId, this.now());
			return {
				duplicate: true,
				cachedResponse: cached.event,
				cachedResponseSeq: cached.seq,
			};
		}

		if (state.seenCommandIds.has(trimmedId)) {
			state.seenCommandIds.set(trimmedId, this.now());
			return { duplicate: true };
		}

		state.seenCommandIds.set(trimmedId, this.now());
		return { duplicate: false };
	}

	scheduleOrphan(sessionId: string): void {
		const state = this.getOrCreateState(sessionId);
		this.cancelOrphan(sessionId);

		state.orphanTimer = this.setTimeoutFn(() => {
			state.orphanTimer = null;
			if (this.hasSubscribers(sessionId)) {
				return;
			}

			this.onAbort(sessionId);

			if (this.orphanAbortDelayMs <= 0) {
				if (!this.hasSubscribers(sessionId)) {
					this.onStop(sessionId);
					this.clearSession(sessionId);
				}
				return;
			}

			state.orphanStopTimer = this.setTimeoutFn(() => {
				state.orphanStopTimer = null;
				if (this.hasSubscribers(sessionId)) {
					return;
				}
				this.onStop(sessionId);
				this.clearSession(sessionId);
			}, this.orphanAbortDelayMs);
		}, this.orphanGraceMs);
	}

	cancelOrphan(sessionId: string): void {
		const state = this.sessions.get(sessionId);
		if (!state) {
			return;
		}
		if (state.orphanTimer) {
			this.clearTimeoutFn(state.orphanTimer);
			state.orphanTimer = null;
		}
		if (state.orphanStopTimer) {
			this.clearTimeoutFn(state.orphanStopTimer);
			state.orphanStopTimer = null;
		}
	}

	clearSession(sessionId: string): void {
		this.cancelOrphan(sessionId);
		this.sessions.delete(sessionId);
	}

	dispose(): void {
		for (const sessionId of this.sessions.keys()) {
			this.cancelOrphan(sessionId);
		}
		this.sessions.clear();
	}

	private getOrCreateState(sessionId: string): SessionReliabilityState {
		let state = this.sessions.get(sessionId);
		if (!state) {
			state = {
				nextSeq: 1,
				events: [],
				seenCommandIds: new Map<string, number>(),
				responseByCommandId: new Map<string, RPCEvent>(),
				orphanTimer: null,
				orphanStopTimer: null,
			};
			this.sessions.set(sessionId, state);
		}
		return state;
	}

	private pruneCommandState(state: SessionReliabilityState): void {
		const now = this.now();
		for (const [commandId, seenAt] of state.seenCommandIds.entries()) {
			if (now - seenAt <= this.commandRetentionMs) {
				continue;
			}
			state.seenCommandIds.delete(commandId);
			state.responseByCommandId.delete(commandId);
		}
	}
}
