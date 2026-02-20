import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as vm from "node:vm";

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
	const a = JSON.stringify(actual);
	const e = JSON.stringify(expected);
	if (a === e) {
		console.log(`  PASS: ${label}`);
		PASS++;
		return;
	}
	console.error(`  FAIL: ${label} (expected ${e}, got ${a})`);
	FAIL++;
}

function wait(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

interface MockResponse {
	ok: boolean;
	status: number;
	json: () => Promise<unknown>;
}

function jsonResponse(body: unknown, status = 200): MockResponse {
	return {
		ok: status >= 200 && status < 300,
		status,
		json: async () => body,
	};
}

interface DashboardVm {
	loading: boolean;
	submissions: Array<{ id: string; status: string; commentCount: number }>;
	refresh: () => Promise<void>;
	init: () => Promise<void>;
	destroy: () => void;
	scheduleRefresh: (delayMs?: number) => void;
	isPanelVisible: () => boolean;
}

function loadReviewDashboard(
	fetchImpl: (url: string) => Promise<MockResponse>,
): {
	dashboard: DashboardVm;
	windowListeners: Map<
		string,
		(event?: { detail?: { name?: string } }) => void
	>;
} {
	const testDir = path.dirname(fileURLToPath(import.meta.url));
	const sourcePath = path.resolve(testDir, "../web/public/js/review-panel.js");
	const source = fs.readFileSync(sourcePath, "utf-8");

	const windowListeners = new Map<
		string,
		(event?: { detail?: { name?: string } }) => void
	>();
	const documentListeners = new Map<string, () => void>();

	const context = {
		fetch: fetchImpl,
		window: {
			addEventListener: (
				type: string,
				cb: (event?: { detail?: { name?: string } }) => void,
			) => {
				windowListeners.set(type, cb);
			},
			removeEventListener: (type: string) => {
				windowListeners.delete(type);
			},
		},
		document: {
			hidden: false,
			addEventListener: (type: string, cb: () => void) => {
				documentListeners.set(type, cb);
			},
			removeEventListener: (type: string) => {
				documentListeners.delete(type);
			},
		},
		setTimeout,
		clearTimeout,
	};

	vm.createContext(context);
	vm.runInContext(source, context, { filename: sourcePath });

	const factory = (context as { rhoReviewDashboard?: () => DashboardVm })
		.rhoReviewDashboard;
	if (typeof factory !== "function") {
		throw new Error("review-panel.js did not define rhoReviewDashboard");
	}

	return {
		dashboard: factory(),
		windowListeners,
	};
}

console.log("\n=== Review Panel Regression Tests ===\n");

console.log("-- stale inbox entry clears from submitted panel refresh --");
{
	const calls: string[] = [];
	const { dashboard } = loadReviewDashboard(async (url) => {
		calls.push(url);
		if (url === "/api/git/status") {
			return jsonResponse({ files: [] });
		}
		if (url === "/api/review/sessions") {
			return jsonResponse([]);
		}
		if (url === "/api/review/submissions?status=submitted&limit=20") {
			return jsonResponse([]);
		}
		if (url === "/api/review/submissions?status=inbox&limit=20") {
			return jsonResponse([
				{ id: "rev-stale", status: "claimed", commentCount: 1 },
			]);
		}
		throw new Error(`unexpected fetch url: ${url}`);
	});

	dashboard.loading = false;
	dashboard.isPanelVisible = () => true;
	dashboard.submissions = [
		{ id: "rev-stale", status: "submitted", commentCount: 1 },
	];

	await dashboard.refresh();

	assert(
		calls.includes("/api/review/submissions?status=submitted&limit=20"),
		"refresh requests submitted-only list for submitted inbox section",
	);
	assert(
		!calls.some((call) => call.includes("status=inbox")),
		"refresh does not request inbox filter for submitted inbox section",
	);
	assertEq(
		dashboard.submissions,
		[],
		"claimed review no longer lingers in submitted inbox after refresh",
	);
}

console.log("\n-- ui-event refresh path also uses submitted-only list --");
{
	const calls: string[] = [];
	const { dashboard, windowListeners } = loadReviewDashboard(async (url) => {
		calls.push(url);
		if (url === "/api/git/status") {
			return jsonResponse({ files: [] });
		}
		if (url === "/api/review/sessions") {
			return jsonResponse([]);
		}
		if (url.startsWith("/api/review/submissions")) {
			return jsonResponse([]);
		}
		throw new Error(`unexpected fetch url: ${url}`);
	});

	await dashboard.init();
	const scheduledDelays: number[] = [];
	dashboard.scheduleRefresh = (delayMs = 0) => {
		scheduledDelays.push(delayMs);
		void dashboard.refresh();
	};

	const onUiEvent = windowListeners.get("rho:ui-event");
	assert(typeof onUiEvent === "function", "ui event listener registered");
	onUiEvent?.({ detail: { name: "review_submissions_changed" } });
	await wait(0);

	assert(
		scheduledDelays.includes(80),
		"review_submissions_changed schedules an 80ms refresh",
	);
	const submissionCalls = calls.filter((call) =>
		call.startsWith("/api/review/submissions"),
	);
	assert(
		submissionCalls.length >= 2,
		"submission list fetched for both polling and ui-event refresh paths",
	);
	assert(
		submissionCalls.every((call) => call.includes("status=submitted")),
		"all submission refreshes use submitted filter",
	);
	dashboard.destroy();
}

console.log(`\n=== Results: ${PASS} passed, ${FAIL} failed ===\n`);
process.exit(FAIL > 0 ? 1 : 0);
