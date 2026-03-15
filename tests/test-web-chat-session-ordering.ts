import path from "node:path";
import { pathToFileURL } from "node:url";

let PASS = 0;
let FAIL = 0;

function assert(condition: boolean, label: string): void {
	if (condition) {
		console.log(`  PASS: ${label}`);
		PASS++;
		return;
	}
	console.error(`  FAIL: ${label}`);
	FAIL++;
}

function assertEq(actual: unknown, expected: unknown, label: string): void {
	if (Object.is(actual, expected)) {
		console.log(`  PASS: ${label}`);
		PASS++;
		return;
	}
	console.error(
		`  FAIL: ${label} (expected ${String(expected)}, got ${String(actual)})`,
	);
	FAIL++;
}

console.log("\n=== Web Chat Session Ordering + Unread Tests ===\n");

const importDir = import.meta.dirname;
if (!importDir) {
	throw new Error("import.meta.dirname is unavailable");
}

const orderingPath = path.resolve(
	importDir,
	"../web/public/js/chat/session-list-ordering.js",
);
const ordering = await import(
	`${pathToFileURL(orderingPath).href}?session-ordering=${Date.now()}`
);

const lifecyclePath = path.resolve(
	importDir,
	"../web/public/js/chat/rpc-session-routing.js",
);
const lifecycle = await import(
	`${pathToFileURL(lifecyclePath).href}?session-ordering-lifecycle=${Date.now()}`
);

console.log(
	"-- comparator: streaming > active non-streaming > history, then recency --",
);
{
	const sessions = [
		{
			id: "sess-history-new",
			timestamp: "2026-02-20T11:00:00.000Z",
		},
		{
			id: "sess-active-old",
			timestamp: "2026-02-20T10:00:00.000Z",
		},
		{
			id: "sess-stream",
			timestamp: "2026-02-20T09:00:00.000Z",
		},
		{
			id: "sess-active-new",
			timestamp: "2026-02-20T08:00:00.000Z",
		},
		{
			id: "sess-history-old",
			timestamp: "2026-02-20T07:00:00.000Z",
		},
	];

	const stateById = new Map([
		[
			"sess-stream",
			{
				status: "streaming",
				rpcSessionId: "rpc-stream",
				sortAnchorAt: 100,
				lastActivityAt: 100,
			},
		],
		[
			"sess-active-old",
			{
				status: "idle",
				rpcSessionId: "rpc-active-old",
				sortAnchorAt: 300,
				lastActivityAt: 300,
			},
		],
		[
			"sess-active-new",
			{
				status: "starting",
				rpcSessionId: "rpc-active-new",
				sortAnchorAt: 500,
				lastActivityAt: 500,
			},
		],
	]);

	const ordered = ordering.sortSessionsForSidebar(sessions, stateById);
	const orderedIds = ordered
		.map((session: { id: string }) => session.id)
		.join(",");
	assertEq(
		orderedIds,
		"sess-stream,sess-active-new,sess-active-old,sess-history-new,sess-history-old",
		"comparator enforces required status grouping + recency",
	);
}

console.log(
	"\n-- history rows prefer updatedAt over session start timestamp --",
);
{
	const ordered = ordering.sortSessionsForSidebar(
		[
			{
				id: "sess-older-start-newer-activity",
				timestamp: "2026-02-20T08:00:00.000Z",
				updatedAt: "2026-02-20T12:00:00.000Z",
			},
			{
				id: "sess-newer-start-older-activity",
				timestamp: "2026-02-20T11:00:00.000Z",
				updatedAt: "2026-02-20T11:30:00.000Z",
			},
		],
		new Map(),
	);
	assertEq(
		ordered.map((session: { id: string }) => session.id).join(","),
		"sess-older-start-newer-activity,sess-newer-start-older-activity",
		"updatedAt controls history recency when available",
	);
}

console.log("\n-- streaming sessions keep stable order across token churn --");
{
	const sessionA = {
		id: "sess-a",
		timestamp: "2026-02-20T11:00:00.000Z",
	};
	const sessionB = {
		id: "sess-b",
		timestamp: "2026-02-20T10:59:00.000Z",
	};
	const stateById = new Map([
		[
			"sess-a",
			{
				status: "streaming",
				rpcSessionId: "rpc-a",
				sortAnchorAt: 200,
				lastActivityAt: 200,
				isStreaming: true,
				isSendingPrompt: false,
				pendingRpcCommands: new Map(),
			},
		],
		[
			"sess-b",
			{
				status: "streaming",
				rpcSessionId: "rpc-b",
				sortAnchorAt: 100,
				lastActivityAt: 100,
				isStreaming: true,
				isSendingPrompt: false,
				pendingRpcCommands: new Map(),
			},
		],
	]);
	const routeA = {
		sessionId: "sess-a",
		rpcSessionId: "rpc-a",
		state: stateById.get("sess-a"),
		isFocused: false,
	};
	const routeB = {
		sessionId: "sess-b",
		rpcSessionId: "rpc-b",
		state: stateById.get("sess-b"),
		isFocused: false,
	};

	const initialOrder = ordering
		.sortSessionsForSidebar([sessionA, sessionB], stateById)
		.map((session: { id: string }) => session.id)
		.join(",");
	assertEq(
		initialOrder,
		"sess-a,sess-b",
		"initial streaming order uses sort anchor",
	);

	for (const route of [routeB, routeA, routeB, routeA]) {
		lifecycle.applyRpcLifecycleToSessionState(route, {
			type: "message_update",
		});
	}

	const churnOrder = ordering
		.sortSessionsForSidebar([sessionA, sessionB], stateById)
		.map((session: { id: string }) => session.id)
		.join(",");
	assertEq(
		churnOrder,
		"sess-a,sess-b",
		"message_update churn does not reorder concurrent streaming sessions",
	);
	assert(
		(stateById.get("sess-a")?.lastActivityAt ?? 0) > 200,
		"token churn still refreshes lastActivityAt for session A",
	);
	assert(
		(stateById.get("sess-b")?.lastActivityAt ?? 0) > 100,
		"token churn still refreshes lastActivityAt for session B",
	);
	assertEq(
		stateById.get("sess-a")?.sortAnchorAt,
		200,
		"token churn leaves session A sort anchor unchanged",
	);
	assertEq(
		stateById.get("sess-b")?.sortAnchorAt,
		100,
		"token churn leaves session B sort anchor unchanged",
	);
}

console.log("\n-- row metadata reflects unread + status signals --");
{
	const stateById = new Map([
		[
			"sess-active",
			{
				status: "idle",
				rpcSessionId: "rpc-active",
				lastActivityAt: Date.now(),
				unreadMilestone: true,
			},
		],
	]);

	const activeMeta = ordering.getSessionRowMeta(
		{ id: "sess-active", timestamp: "2026-02-20T12:00:00.000Z" },
		stateById,
	);
	assertEq(activeMeta.status, "idle", "metadata uses tracked session status");
	assertEq(
		activeMeta.isActiveRuntime,
		true,
		"metadata marks rpc-bound session as active runtime",
	);
	assertEq(
		activeMeta.unreadMilestone,
		true,
		"metadata carries unread milestone flag",
	);
	assertEq(activeMeta.sortAnchorAt, 0, "metadata exposes sidebar sort anchor");

	const inactiveMeta = ordering.getSessionRowMeta(
		{ id: "sess-history", timestamp: "2026-02-20T12:01:00.000Z" },
		stateById,
	);
	assertEq(
		inactiveMeta.isActiveRuntime,
		false,
		"metadata marks unknown sessions as inactive history",
	);
}

console.log(
	"\n-- unread transitions: background activity + completion/error + clear on focused resync --",
);
{
	const backgroundState = {
		sessionId: "sess-a",
		rpcSessionId: "rpc-a",
		sessionFile: "/tmp/sess-a.jsonl",
		status: "idle",
		unreadMilestone: false,
		lastActivityAt: 0,
		isStreaming: false,
		isSendingPrompt: false,
		pendingRpcCommands: new Map(),
	};
	const backgroundRoute = {
		sessionId: "sess-a",
		rpcSessionId: "rpc-a",
		state: backgroundState,
		isFocused: false,
	};

	lifecycle.applyRpcLifecycleToSessionState(backgroundRoute, {
		type: "message_update",
	});
	assertEq(
		backgroundState.unreadMilestone,
		false,
		"token churn alone does not set unread",
	);

	lifecycle.applyRpcLifecycleToSessionState(backgroundRoute, {
		type: "tool_execution_start",
	});
	assertEq(
		backgroundState.unreadMilestone,
		true,
		"background tool starts mark unread",
	);

	backgroundState.unreadMilestone = false;
	lifecycle.applyRpcLifecycleToSessionState(backgroundRoute, {
		type: "message_start",
	});
	assertEq(
		backgroundState.unreadMilestone,
		true,
		"background message start marks unread",
	);

	backgroundState.unreadMilestone = false;
	lifecycle.applyRpcLifecycleToSessionState(backgroundRoute, {
		type: "agent_end",
	});
	assertEq(
		backgroundState.unreadMilestone,
		true,
		"background agent_end sets unread",
	);

	backgroundState.unreadMilestone = false;
	lifecycle.applyRpcLifecycleToSessionState(backgroundRoute, {
		type: "rpc_error",
		message: "boom",
	});
	assertEq(
		backgroundState.unreadMilestone,
		true,
		"background rpc_error sets unread",
	);

	const focusedState = {
		...backgroundState,
		unreadMilestone: true,
		error: "",
	};
	const focusedRoute = {
		sessionId: "sess-a",
		rpcSessionId: "rpc-a",
		state: focusedState,
		isFocused: true,
	};

	lifecycle.applyRpcLifecycleToSessionState(focusedRoute, {
		type: "message_update",
	});
	assertEq(
		focusedState.unreadMilestone,
		true,
		"focused non-resync events do not clear unread milestone",
	);

	lifecycle.applyRpcLifecycleToSessionState(focusedRoute, {
		type: "response",
		command: "get_state",
		success: true,
		state: { isStreaming: false },
	});
	assertEq(
		focusedState.unreadMilestone,
		false,
		"focused successful get_state resync clears unread milestone",
	);
}

console.log("\n-- stopped/idle-timeout sessions clear runtime binding --");
{
	const state = {
		sessionId: "sess-stop",
		rpcSessionId: "rpc-stop",
		status: "idle",
		lastActivityAt: 0,
		isStreaming: false,
		isSendingPrompt: true,
		recoveringRpcSession: true,
		replayingPendingRpc: true,
		error: "boom",
		pendingRpcCommands: new Map([["cmd-1", { ok: true }]]),
	};
	const route = {
		sessionId: "sess-stop",
		rpcSessionId: "rpc-stop",
		state,
		isFocused: false,
	};

	lifecycle.applyRpcLifecycleToSessionState(route, {
		type: "rpc_idle_timeout",
		message: "Session stopped after inactivity",
	});
	assertEq(state.rpcSessionId, "", "idle timeout clears rpc binding");
	assertEq(state.isSendingPrompt, false, "idle timeout clears sending flag");
	assertEq(
		state.pendingRpcCommands.size,
		0,
		"idle timeout clears pending commands",
	);
	assertEq(
		state.recoveringRpcSession,
		false,
		"idle timeout clears recover state",
	);
	assertEq(
		state.replayingPendingRpc,
		false,
		"idle timeout clears replay state",
	);

	state.rpcSessionId = "rpc-stop-2";
	state.isSendingPrompt = true;
	state.pendingRpcCommands.set("cmd-2", { ok: true });
	state.error = "still here";
	lifecycle.applyRpcLifecycleToSessionState(route, {
		type: "rpc_session_stopped",
	});
	assertEq(state.rpcSessionId, "", "session stopped clears rpc binding");
	assertEq(state.error, "", "session stopped clears stale error message");
	assertEq(state.status, "idle", "session stopped leaves session idle");
}

console.log(`\n=== Results: ${PASS} passed, ${FAIL} failed ===\n`);
process.exit(FAIL > 0 ? 1 : 0);
