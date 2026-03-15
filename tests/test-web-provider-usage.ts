import fs from "node:fs";
import os from "node:os";
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

console.log("\n=== Web Provider Usage Tests ===\n");

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "rho-provider-home-"));
const tempRhoHome = fs.mkdtempSync(path.join(os.tmpdir(), "rho-provider-rho-"));
process.env.HOME = tempHome;
process.env.RHO_HOME = tempRhoHome;
fs.writeFileSync(
	path.join(tempRhoHome, "init.toml"),
	["[settings.web]", "auth_enabled = false"].join("\n"),
	"utf-8",
);

const authDir = path.join(tempHome, ".pi", "agent");
const authPath = path.join(authDir, "auth.json");
fs.mkdirSync(authDir, { recursive: true });

const serverUrl = pathToFileURL(path.resolve("web/server.ts")).href;
const { default: app } = await import(`${serverUrl}?test=${Date.now()}`);

const originalFetch = globalThis.fetch;

type MockUsageResponse = {
	status?: number;
	body?: Record<string, unknown>;
};

function installFetchMock(mock: MockUsageResponse): void {
	globalThis.fetch = (async (input: RequestInfo | URL) => {
		const url =
			typeof input === "string"
				? input
				: input instanceof URL
					? input.href
					: input.url;
		if (url === "https://chatgpt.com/backend-api/wham/usage") {
			return new Response(JSON.stringify(mock.body ?? {}), {
				status: mock.status ?? 200,
				headers: { "Content-Type": "application/json" },
			});
		}
		throw new Error(`Unexpected fetch: ${url}`);
	}) as typeof fetch;
}

try {
	console.log("-- /api/provider-usage returns remaining Codex windows --");
	{
		fs.writeFileSync(
			authPath,
			`${JSON.stringify({
				"openai-codex": { access: "codex-access-token" },
			})}\n`,
			"utf-8",
		);
		installFetchMock({
			body: {
				plan_type: "plus",
				rate_limit: {
					primary_window: { used_percent: 38, reset_after_seconds: 7200 },
					secondary_window: { used_percent: 12, reset_after_seconds: 172800 },
				},
			},
		});

		const res = await app.fetch(
			new Request("http://localhost/api/provider-usage"),
		);
		assertEq(res.status, 200, "GET /api/provider-usage → 200");
		const payload = (await res.json()) as {
			codex?: Record<string, unknown>;
		};
		assertEq(payload.codex?.loggedIn, true, "codex marked logged in");
		assertEq(payload.codex?.available, true, "codex usage marked available");
		assertEq(payload.codex?.planType, "plus", "plan type returned");
		assertEq(
			payload.codex?.primaryRemainingPercent,
			62,
			"primary remaining percent computed",
		);
		assertEq(
			payload.codex?.secondaryRemainingPercent,
			88,
			"secondary remaining percent computed",
		);
	}

	console.log("\n-- /api/provider-usage handles missing auth.json --");
	{
		fs.rmSync(authPath, { force: true });
		installFetchMock({ body: {} });
		const res = await app.fetch(
			new Request("http://localhost/api/provider-usage"),
		);
		assertEq(res.status, 200, "GET /api/provider-usage without auth → 200");
		const payload = (await res.json()) as {
			codex?: Record<string, unknown>;
		};
		assertEq(payload.codex?.loggedIn, false, "codex marked logged out");
		assertEq(payload.codex?.available, false, "usage unavailable without auth");
	}

	console.log(
		"\n-- /api/provider-usage surfaces upstream failures without leaking tokens --",
	);
	{
		fs.writeFileSync(
			authPath,
			`${JSON.stringify({
				"openai-codex": { access: "codex-access-token" },
			})}\n`,
			"utf-8",
		);
		installFetchMock({ status: 403, body: { error: "denied" } });
		const res = await app.fetch(
			new Request("http://localhost/api/provider-usage"),
		);
		assertEq(res.status, 200, "GET /api/provider-usage upstream error → 200");
		const payload = (await res.json()) as {
			codex?: Record<string, unknown>;
		};
		assertEq(
			payload.codex?.loggedIn,
			true,
			"loggedIn remains true on upstream error",
		);
		assertEq(
			payload.codex?.available,
			false,
			"available false on upstream error",
		);
		assertEq(payload.codex?.error, "HTTP 403", "upstream HTTP error surfaced");
		assert(
			!JSON.stringify(payload).includes("codex-access-token"),
			"access token not leaked",
		);
	}
} finally {
	globalThis.fetch = originalFetch;
	fs.rmSync(tempHome, { recursive: true, force: true });
	fs.rmSync(tempRhoHome, { recursive: true, force: true });
}

console.log(`\n=== Results: ${PASS} passed, ${FAIL} failed ===\n`);
process.exit(FAIL > 0 ? 1 : 0);
