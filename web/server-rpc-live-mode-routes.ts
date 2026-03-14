import { app, rpcManager } from "./server-core.ts";
import {
	rpcLiveModeLeases,
	type RpcLiveModeLease,
} from "./rpc-live-mode-lease.ts";

type LeaseRequestBody = {
	rpcSessionId?: unknown;
	ttlMs?: unknown;
};

function formatLease(lease: RpcLiveModeLease): Record<string, unknown> {
	return {
		rpcSessionId: lease.rpcSessionId,
		ttlMs: lease.ttlMs,
		updatedAt: lease.updatedAt,
		expiresAt: lease.expiresAt,
	};
}

function normalizeSessionId(value: unknown): string {
	if (typeof value !== "string") {
		return "";
	}
	return value.trim();
}

function activeSessionExists(rpcSessionId: string): boolean {
	if (!rpcSessionId) {
		return false;
	}
	for (const session of rpcManager.getActiveSessions()) {
		if (session.id === rpcSessionId) {
			return true;
		}
	}
	return false;
}

app.post("/api/mobile/live-mode/lease", async (c) => {
	let body: LeaseRequestBody = {};
	try {
		body = (await c.req.json()) as LeaseRequestBody;
	} catch {
		return c.json({ error: "Invalid JSON body" }, 400);
	}

	const rpcSessionId = normalizeSessionId(body.rpcSessionId);
	if (!rpcSessionId) {
		return c.json({ error: "rpcSessionId is required" }, 400);
	}

	if (!activeSessionExists(rpcSessionId)) {
		return c.json({ error: "Unknown rpcSessionId" }, 404);
	}

	const lease = rpcLiveModeLeases.upsert(rpcSessionId, body.ttlMs);
	if (!lease) {
		return c.json({ error: "Failed to create lease" }, 400);
	}

	return c.json({ ok: true, lease: formatLease(lease) });
});

app.post("/api/mobile/live-mode/lease/clear", async (c) => {
	let body: LeaseRequestBody = {};
	try {
		body = (await c.req.json()) as LeaseRequestBody;
	} catch {
		return c.json({ error: "Invalid JSON body" }, 400);
	}

	const rpcSessionId = normalizeSessionId(body.rpcSessionId);
	if (!rpcSessionId) {
		return c.json({ error: "rpcSessionId is required" }, 400);
	}

	const cleared = rpcLiveModeLeases.clear(rpcSessionId);
	return c.json({ ok: true, cleared, rpcSessionId });
});

app.get("/api/mobile/live-mode/leases", (c) => {
	const leases = rpcLiveModeLeases.snapshot().map(formatLease);
	return c.json({ count: leases.length, leases });
});
