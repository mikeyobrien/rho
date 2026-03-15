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

console.log("\n=== Web Config Provider Usage UI Tests ===\n");

type Listener = (...args: unknown[]) => void;

type ConfigVm = {
	init: () => Promise<void>;
	loadProviderUsage: () => Promise<void>;
	codexUsageVisible: () => boolean;
	codexUsageAvailable: () => boolean;
	codexPlanLabel: () => string;
	codexWindowRemainingLabel: (kind: string) => string;
	filePath: string;
	rhoVersion: string;
	content: string;
	codexUsage: Record<string, unknown> | null;
};

async function loadConfigVm(fetchImpl: typeof fetch): Promise<ConfigVm> {
	const listeners = new Map<string, Listener>();
	let factory: (() => ConfigVm) | null = null;
	const globals = globalThis as unknown as Record<string, unknown>;

	globals.document = {
		addEventListener: (type: string, cb: Listener) => {
			listeners.set(type, cb);
		},
		body: {
			classList: {
				toggle: () => {},
			},
		},
	};
	globals.window = {
		location: {
			href: "http://localhost/",
			search: "",
		},
	};
	globals.localStorage = {
		getItem: () => null,
		setItem: () => {},
	};
	globals.fetch = fetchImpl;
	globals.Alpine = {
		data: (_name: string, fn: () => ConfigVm) => {
			factory = fn;
		},
	};
	globals.setTimeout = (fn: () => void) => {
		fn();
		return 0;
	};

	const configUrl = pathToFileURL(path.resolve("web/public/js/config.js")).href;
	await import(`${configUrl}?test=${Date.now()}`);
	const initListener = listeners.get("alpine:init");
	if (!initListener) {
		throw new Error("config.js did not register alpine:init listener");
	}
	initListener();
	if (!factory) {
		throw new Error("config.js did not register Alpine.data factory");
	}
	return factory();
}

console.log("-- config view loads and formats Codex usage --");
{
	const vm = await loadConfigVm(async (input: RequestInfo | URL) => {
		const url =
			typeof input === "string"
				? input
				: input instanceof URL
					? input.href
					: input.url;
		if (url === "/api/config") {
			return new Response(
				JSON.stringify({
					path: "/tmp/init.toml",
					version: "0.1.11",
					content: "[settings.web]",
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		}
		if (url === "/api/provider-usage") {
			return new Response(
				JSON.stringify({
					codex: {
						loggedIn: true,
						available: true,
						planType: "plus",
						primaryRemainingPercent: 62,
						primaryResetAfterSeconds: 7200,
						secondaryRemainingPercent: 88,
						secondaryResetAfterSeconds: 172800,
					},
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		}
		throw new Error(`Unexpected fetch: ${url}`);
	});

	await vm.init();
	assertEq(vm.filePath, "/tmp/init.toml", "config path loaded");
	assertEq(vm.rhoVersion, "0.1.11", "rho version loaded");
	assertEq(vm.content, "[settings.web]", "config content loaded");
	assert(vm.codexUsageVisible(), "Codex usage visible when logged in");
	assert(vm.codexUsageAvailable(), "Codex usage marked available");
	assertEq(vm.codexPlanLabel(), "Plan: plus", "plan label formatted");
	assertEq(
		vm.codexWindowRemainingLabel("primary"),
		"62% remaining · resets in 2h",
		"primary remaining label formatted",
	);
	assertEq(
		vm.codexWindowRemainingLabel("secondary"),
		"88% remaining · resets in 2d",
		"secondary remaining label formatted",
	);
}

console.log("\n-- config view hides Codex usage when not logged in --");
{
	const vm = await loadConfigVm(async (input: RequestInfo | URL) => {
		const url =
			typeof input === "string"
				? input
				: input instanceof URL
					? input.href
					: input.url;
		if (url === "/api/config") {
			return new Response(
				JSON.stringify({
					path: "/tmp/init.toml",
					version: "0.1.11",
					content: "",
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		}
		if (url === "/api/provider-usage") {
			return new Response(
				JSON.stringify({ codex: { loggedIn: false, available: false } }),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		}
		throw new Error(`Unexpected fetch: ${url}`);
	});

	await vm.init();
	assertEq(vm.codexUsageVisible(), false, "Codex usage hidden when logged out");
}

console.log(`\n=== Results: ${PASS} passed, ${FAIL} failed ===\n`);
process.exit(FAIL > 0 ? 1 : 0);
