import path from "node:path";
import { pathToFileURL } from "node:url";

let PASS = 0;
let FAIL = 0;

function assert(condition: boolean, label: string): void {
	if (condition) {
		console.log(`  PASS: ${label}`);
		PASS += 1;
		return;
	}
	console.error(`  FAIL: ${label}`);
	FAIL += 1;
}

function assertEq(actual: unknown, expected: unknown, label: string): void {
	if (Object.is(actual, expected)) {
		console.log(`  PASS: ${label}`);
		PASS += 1;
		return;
	}
	console.error(
		`  FAIL: ${label} (expected ${String(expected)}, got ${String(actual)})`,
	);
	FAIL += 1;
}

type PendingEntry = {
	payload: Record<string, unknown>;
	queuedAt: number;
};

type VmLike = {
	pendingRpcCommands?: Map<string, PendingEntry>;
	sessionStateById?: Map<
		string,
		{ pendingRpcCommands?: Map<string, PendingEntry> }
	>;
	wsPendingStaleMs?: number;
};

function makePending(now: number, ageMs: number): Map<string, PendingEntry> {
	return new Map([
		[
			"cmd-1",
			{
				payload: { type: "rpc_command" },
				queuedAt: now - ageMs,
			},
		],
	]);
}

console.log("\n=== RPC Health Watchdog Tests ===\n");

const importDir = import.meta.dirname;
if (!importDir) {
	throw new Error("import.meta.dirname is unavailable");
}
const modulePath = path.resolve(
	importDir,
	"../web/public/js/chat/rpc-health-watchdog.js",
);
const moduleUrl = `${pathToFileURL(modulePath).href}?watchdog-test=${Date.now()}`;
const mod = await import(moduleUrl);

const hasStalePendingRpcCommands = mod.hasStalePendingRpcCommands as (
	vm: VmLike,
	now?: number,
) => boolean;
const bumpPendingRpcQueuedAt = mod.bumpPendingRpcQueuedAt as (
	vm: VmLike,
	now?: number,
) => void;

console.log("-- stale pending detection (focused map) --");
{
	const now = Date.now();
	const vm: VmLike = {
		pendingRpcCommands: makePending(now, 45_000),
		sessionStateById: new Map(),
	};
	assert(
		hasStalePendingRpcCommands(vm, now),
		"stale focused pending command is detected",
	);
}

console.log("\n-- stale pending detection (background map) --");
{
	const now = Date.now();
	const vm: VmLike = {
		pendingRpcCommands: new Map(),
		sessionStateById: new Map([
			[
				"sess-a",
				{
					pendingRpcCommands: makePending(now, 40_000),
				},
			],
		]),
	};
	assert(
		hasStalePendingRpcCommands(vm, now),
		"stale background pending command is detected",
	);
}

console.log("\n-- custom stale threshold respected --");
{
	const now = Date.now();
	const vm: VmLike = {
		pendingRpcCommands: makePending(now, 10_000),
		sessionStateById: new Map(),
		wsPendingStaleMs: 20_000,
	};
	assertEq(
		hasStalePendingRpcCommands(vm, now),
		false,
		"pending command younger than custom threshold is not stale",
	);
}

console.log("\n-- queuedAt bump refreshes all pending maps --");
{
	const before = Date.now() - 50_000;
	const now = Date.now();
	const focused = new Map<string, PendingEntry>([
		["focused", { payload: { id: "focused" }, queuedAt: before }],
	]);
	const background = new Map<string, PendingEntry>([
		["background", { payload: { id: "background" }, queuedAt: before }],
	]);
	const vm: VmLike = {
		pendingRpcCommands: focused,
		sessionStateById: new Map([["sess-a", { pendingRpcCommands: background }]]),
	};

	bumpPendingRpcQueuedAt(vm, now);

	assertEq(
		focused.get("focused")?.queuedAt,
		now,
		"focused pending queuedAt is refreshed",
	);
	assertEq(
		background.get("background")?.queuedAt,
		now,
		"background pending queuedAt is refreshed",
	);
}

assert(PASS > 0, "at least one assertion executed");
console.log(`\n=== Results: ${PASS} passed, ${FAIL} failed ===\n`);
process.exit(FAIL > 0 ? 1 : 0);
