/**
 * Exclusive multiplexer routing. Run: npx tsx tests/test-multiplexer.ts
 */
import {
	herdrArgv,
	resolveMultiplexer,
	runHerdrPane,
} from "../extensions/lib/multiplexer.ts";

let failed = 0;

function assert(condition: boolean, label: string): void {
	if (condition) {
		console.log(`  PASS: ${label}`);
		return;
	}
	failed += 1;
	console.error(`  FAIL: ${label}`);
}

assert(
	resolveMultiplexer({ herdrAvailable: true }).host === "herdr",
	"auto selects herdr",
);
assert(
	resolveMultiplexer({ requested: "tmux", herdrAvailable: true }).host === "tmux",
	"explicit tmux stays tmux",
);
assert(
	Boolean(resolveMultiplexer({ requested: "herdr", herdrAvailable: false }).error),
	"forced herdr does not fall back to tmux",
);

const calls: string[][] = [];
const result = runHerdrPane({
	label: "heartbeat",
	command: "rho agent",
	cwd: "/home/rho/workspace",
	replace: true,
	run: (args) => {
		calls.push([...args]);
		if (args.includes("list")) {
			return {
				status: 0,
				stdout: JSON.stringify({ result: { tabs: [{ label: "heartbeat", tab_id: "w1:t2" }] } }),
				stderr: "",
			};
		}
		if (args.includes("create")) {
			return {
				status: 0,
				stdout: JSON.stringify({ result: { root_pane: { pane_id: "w1:p2" } } }),
				stderr: "",
			};
		}
		return { status: 0, stdout: "", stderr: "" };
	},
});

assert(result.ok && result.target === "rho:heartbeat", "herdr pane reports rho target");
assert(calls.every((args) => args[0] === "--session" && args[1] === "rho"), "every call is the rho session");
assert(!calls.some((args) => args.includes("tmux")), "herdr path never calls tmux");
assert(
	calls.some((args) => args.includes("close") && args.includes("w1:t2")) &&
		calls.at(-1)?.includes("w1:p2"),
	"replaces the old pane then runs there",
);
assert(herdrArgv(["tab", "list"])[1] === "rho", "argv helper scopes the session");

if (failed > 0) {
	console.error(`\n${failed} failed`);
	process.exit(1);
}
console.log("\nall passed");
