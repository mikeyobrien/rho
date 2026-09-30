/**
 * Durable job queue and resource-based capacity.
 * Run: npx tsx tests/test-jobs.ts
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveJevRoute } from "../cli/job-admission.ts";
import {
	type Job,
	buildWorkPrompt,
	cancelJob,
	delegateJob,
	delegateMessage,
	jevRoute,
	listJobs,
	readJevEnabled,
	replyToJob,
	updateJob,
} from "../extensions/lib/jobs.ts";

let PASS = 0;
let FAIL = 0;

function assert(condition: boolean, label: string): void {
	if (condition) {
		console.log(`  PASS: ${label}`);
		PASS++;
	} else {
		console.error(`  FAIL: ${label}`);
		FAIL++;
	}
}

function assertEq(actual: unknown, expected: unknown, label: string): void {
	const ok = JSON.stringify(actual) === JSON.stringify(expected);
	if (ok) {
		console.log(`  PASS: ${label}`);
		PASS++;
	} else {
		console.error(
			`  FAIL: ${label} — got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`,
		);
		FAIL++;
	}
}

function tempRho(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "rho-jobs-"));
}

function job(partial: Partial<Job> & Pick<Job, "id" | "status">): Job {
	return {
		title: partial.title ?? partial.id,
		prompt: partial.prompt ?? "do the thing",
		cwd: partial.cwd ?? "/tmp",
		question: partial.question ?? null,
		result: partial.result ?? null,
		error: partial.error ?? null,
		createdAt: partial.createdAt ?? "2026-09-23T00:00:00.000Z",
		updatedAt: partial.updatedAt ?? "2026-09-23T00:00:00.000Z",
		pid: partial.pid ?? null,
		notify: partial.notify ?? "pending",
		...partial,
	};
}

console.log("\n=== jev routing ===\n");

assert(readJevEnabled(undefined), "missing enabled defaults on");
assert(!readJevEnabled(false), "jev.enabled = false is off");
assert(readJevEnabled(true), "jev.enabled = true is on");
assert(
	!jevRoute({ enabled: true, hasApiKey: false }),
	"no API key does not route",
);
assert(
	!jevRoute({ enabled: false, hasApiKey: true }),
	"disabled does not route even with a key",
);
assert(
	jevRoute({ enabled: true, hasApiKey: true }),
	"enabled plus a key routes",
);
assertEq(
	resolveJevRoute({
		enabled: true,
		env: { TYPESAFE_API_KEY: "test-key" },
	}).route,
	true,
	"settings route when the key exists",
);
assertEq(
	resolveJevRoute({
		enabled: false,
		env: { TYPESAFE_API_KEY: "test-key" },
	}).route,
	false,
	"settings do not route when disabled",
);

console.log("\n=== delegate ===\n");

{
	const rhoDir = tempRho();
	const first = await delegateJob(
		rhoDir,
		{ title: "Fix tests", prompt: "Fix the rho CLI test", cwd: "/work" },
		{ daemonUp: false },
	);
	assertEq(first.created, true, "first delegate creates a job");
	assertEq(first.job.status, "queued", "new job is queued");
	assert(
		first.text.includes("rho start"),
		"daemon-down text says to start the daemon",
	);
	assert(
		!/do (this|the) job yourself|run it inline|fallback/i.test(first.text),
		"daemon-down text does not tell chat to run the job",
	);
	const second = await delegateJob(
		rhoDir,
		{ title: "Fix tests", prompt: "Fix the rho CLI test", cwd: "/work" },
		{ daemonUp: true },
	);
	assertEq(second.created, false, "duplicate queued delegate is not created");
	assertEq(second.job.id, first.job.id, "duplicate returns the same id");
	assertEq(listJobs(rhoDir).length, 1, "log has one job");
}

console.log("\n=== reply and cancel ===\n");

{
	const rhoDir = tempRho();
	const created = await delegateJob(
		rhoDir,
		{ title: "Ask", prompt: "Need a path", cwd: "/work" },
		{ daemonUp: true },
	);
	await updateJob(rhoDir, created.job.id, {
		status: "waiting_input",
		question: "which file?",
	});
	let replyError = "";
	try {
		await replyToJob(rhoDir, created.job.id, "   ");
	} catch (error) {
		replyError = error instanceof Error ? error.message : String(error);
	}
	assert(replyError.includes("reply required"), "blank reply is rejected");
	const resumed = await replyToJob(rhoDir, created.job.id, "src/cli.ts");
	assertEq(resumed.status, "queued", "reply requeues a waiting job");
	assertEq(resumed.question, null, "reply clears the question");
	let wrong = "";
	try {
		await replyToJob(rhoDir, created.job.id, "again");
	} catch (error) {
		wrong = error instanceof Error ? error.message : String(error);
	}
	assert(wrong.includes("not waiting_input"), "reply rejects a queued job");
	const cancelled = await cancelJob(rhoDir, created.job.id);
	assertEq(cancelled.status, "cancelled", "cancel marks the job cancelled");
}

console.log("\n=== prompt ===\n");

{
	const text = buildWorkPrompt([
		job({ id: "job-1", status: "running" }),
		job({
			id: "job-2",
			status: "waiting_input",
			title: "Import",
			question: "which file?",
		}),
	]);
	assert(text.includes("1 running"), "prompt counts running jobs");
	assert(text.includes("job-2"), "prompt names a blocked job");
	assert(text.includes("Do not poll"), "prompt forbids polling");
	assert(
		!text.includes("rho_subagent") || text.includes("unless the user asked"),
		"visible panes stay opt-in",
	);
	assert(
		delegateMessage("job-9", "Fix", false).includes("until `rho start`"),
		"shared daemon-down wording",
	);
}

console.log(`\n${PASS} passed, ${FAIL} failed\n`);
if (FAIL > 0) process.exit(1);
