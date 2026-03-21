import { readFileSync } from "node:fs";
import path from "node:path";
import {
	TerminalManager,
	setNodePtyLoaderForTests,
} from "../web/terminal-manager.ts";

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

console.log("\n=== Termux Install Gracefulness Tests ===\n");

console.log("-- package.json keeps node-pty optional --");
{
	const packageJson = JSON.parse(
		readFileSync(path.resolve(process.cwd(), "package.json"), "utf-8"),
	) as {
		dependencies?: Record<string, string>;
		optionalDependencies?: Record<string, string>;
	};

	assertEq(
		packageJson.optionalDependencies?.["node-pty"],
		"^1.1.0",
		"node-pty is declared as an optional dependency",
	);
	assert(
		!("node-pty" in (packageJson.dependencies || {})),
		"node-pty is removed from required dependencies",
	);
}

console.log("\n-- terminal manager degrades cleanly when node-pty is unavailable --");
{
	setNodePtyLoaderForTests(() => {
		throw new Error("simulated missing native binding");
	});

	try {
		const manager = new TerminalManager();
		let message = "";
		try {
			manager.createSession();
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}

		assert(
			message.includes("optional dependency node-pty could not be loaded"),
			"createSession reports node-pty load failure clearly",
		);
		assert(
			message.includes("Core rho still installs and runs without it"),
			"createSession explains that rho still works without embedded terminal",
		);
	} finally {
		setNodePtyLoaderForTests(null);
	}
}

console.log(`\n=== Results: ${PASS} passed, ${FAIL} failed ===\n`);
process.exit(FAIL > 0 ? 1 : 0);
