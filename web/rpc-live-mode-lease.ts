export interface RpcLiveModeLease {
	rpcSessionId: string;
	ttlMs: number;
	updatedAt: number;
	expiresAt: number;
}

const DEFAULT_LEASE_TTL_MS = 3 * 60_000;
const MIN_LEASE_TTL_MS = 30_000;
const MAX_LEASE_TTL_MS = 30 * 60_000;

function normalizeRpcSessionId(value: unknown): string {
	if (typeof value !== "string") {
		return "";
	}
	return value.trim();
}

function normalizeLeaseTtlMs(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return DEFAULT_LEASE_TTL_MS;
	}
	return Math.max(
		MIN_LEASE_TTL_MS,
		Math.min(MAX_LEASE_TTL_MS, Math.floor(value)),
	);
}

export class RpcLiveModeLeaseRegistry {
	private readonly leases = new Map<string, RpcLiveModeLease>();
	private readonly now: () => number;

	constructor(now: () => number = () => Date.now()) {
		this.now = now;
	}

	upsert(rpcSessionId: unknown, ttlMs?: unknown): RpcLiveModeLease | null {
		const normalizedId = normalizeRpcSessionId(rpcSessionId);
		if (!normalizedId) {
			return null;
		}

		const normalizedTtl = normalizeLeaseTtlMs(ttlMs);
		const now = this.now();
		const lease: RpcLiveModeLease = {
			rpcSessionId: normalizedId,
			ttlMs: normalizedTtl,
			updatedAt: now,
			expiresAt: now + normalizedTtl,
		};
		this.leases.set(normalizedId, lease);
		return lease;
	}

	clear(rpcSessionId: unknown): boolean {
		const normalizedId = normalizeRpcSessionId(rpcSessionId);
		if (!normalizedId) {
			return false;
		}
		return this.leases.delete(normalizedId);
	}

	get(rpcSessionId: unknown): RpcLiveModeLease | null {
		const normalizedId = normalizeRpcSessionId(rpcSessionId);
		if (!normalizedId) {
			return null;
		}
		const lease = this.leases.get(normalizedId);
		if (!lease) {
			return null;
		}
		if (lease.expiresAt <= this.now()) {
			this.leases.delete(normalizedId);
			return null;
		}
		return lease;
	}

	hasActive(rpcSessionId: unknown): boolean {
		return this.get(rpcSessionId) !== null;
	}

	remainingMs(rpcSessionId: unknown): number {
		const lease = this.get(rpcSessionId);
		if (!lease) {
			return 0;
		}
		return Math.max(0, lease.expiresAt - this.now());
	}

	snapshot(): RpcLiveModeLease[] {
		this.sweepExpired();
		return [...this.leases.values()].sort((a, b) =>
			a.rpcSessionId.localeCompare(b.rpcSessionId),
		);
	}

	sweepExpired(): number {
		const now = this.now();
		let removed = 0;
		for (const [rpcSessionId, lease] of this.leases.entries()) {
			if (lease.expiresAt > now) {
				continue;
			}
			this.leases.delete(rpcSessionId);
			removed += 1;
		}
		return removed;
	}

	clearAll(): void {
		this.leases.clear();
	}
}

export const rpcLiveModeLeases = new RpcLiveModeLeaseRegistry();

export {
	DEFAULT_LEASE_TTL_MS,
	MIN_LEASE_TTL_MS,
	MAX_LEASE_TTL_MS,
	normalizeRpcSessionId,
	normalizeLeaseTtlMs,
};
