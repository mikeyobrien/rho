/**
 * Regression test: extension notifications must not leak into a normal reply.
 *
 * `ctx.ui.notify()` reaches the RPC runner as an `extension_ui_request` with
 * method `notify`. For a slash command that text is the command's output, so
 * it belongs in the reply (see test-rpc-slash-notify-race.ts). For a normal
 * prompt it is not the reply: auto-memory's receipt for one run
 * ("Auto-memory: +1 saved: ...") arrives a few seconds after that run's
 * agent_end, when the next queued Telegram message may already be pending,
 * and it was prepended to that answer.
 *
 * Run: npx tsx tests/test-rpc-notify-reply.ts
 */

import { EventEmitter } from "node:events";
import { TelegramRpcRunner } from "../extensions/telegram/rpc.ts";

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

type Line = Record<string, unknown>;

/** A fake `pi --mode rpc`: records the commands written to it, emits JSON lines on demand. */
function createMockProcess() {
	const stdout = new EventEmitter();
	const stderr = new EventEmitter();
	const written: Line[] = [];
	const stdin = {
		write: (data: string, _enc?: string) => {
			for (const line of String(data).split("\n")) {
				if (line.trim()) written.push(JSON.parse(line));
			}
			return true;
		},
		writable: true,
		destroyed: false,
	};
	// biome-ignore lint/suspicious/noExplicitAny: mock needs to match ChildProcess shape
	(stdout as any).setEncoding = () => {};
	// biome-ignore lint/suspicious/noExplicitAny: mock needs to match ChildProcess shape
	(stderr as any).setEncoding = () => {};
	const proc = Object.assign(new EventEmitter(), {
		stdout,
		stderr,
		stdin,
		pid: 99998,
		killed: false,
		kill: () => {},
	});
	const emitLine = (obj: Line) => {
		stdout.emit("data", `${JSON.stringify(obj)}\n`);
	};
	return { proc, emitLine, written };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));
// The shape pi's rpc mode writes for ctx.ui.notify(message, type).
const notify = (message: string): Line => ({
	type: "extension_ui_request",
	id: `notify-${Math.random()}`,
	method: "notify",
	message,
	notifyType: "info",
});
const answer = (text: string): Line => ({
	type: "message_end",
	message: {
		role: "assistant",
		stopReason: "stop",
		content: [{ type: "text", text }],
	},
});
const RECEIPT = 'Auto-memory: +1 saved: "Prefers short replies"';

console.log("\n=== RPC extension notify vs. normal reply tests ===\n");

const { proc, emitLine, written } = createMockProcess();
// biome-ignore lint/suspicious/noExplicitAny: mock spawn factory
const runner = new TelegramRpcRunner((() => proc) as any);
const ackPrompt = () => {
	const prompt = written.filter((c) => c.type === "prompt").at(-1);
	emitLine({
		type: "response",
		command: "prompt",
		id: prompt?.id,
		success: true,
	});
};

console.log("-- notify arrives before the answer of a normal prompt --");
{
	const reply = runner.runPrompt("/tmp/test-notify.jsonl", "hello", 5_000);
	await tick();
	ackPrompt();
	emitLine(notify(RECEIPT));
	emitLine(answer("the answer"));
	emitLine({ type: "agent_end" });
	const text = await reply;
	assert(
		text === "the answer",
		`reply is the answer only: ${JSON.stringify(text)}`,
	);
}

console.log("\n-- notify arrives between the answer and agent_end --");
{
	const reply = runner.runPrompt("/tmp/test-notify.jsonl", "more", 5_000);
	await tick();
	ackPrompt();
	emitLine(answer("second answer"));
	emitLine(notify(RECEIPT));
	emitLine({ type: "agent_end" });
	const text = await reply;
	assert(
		text === "second answer",
		`reply is the answer only: ${JSON.stringify(text)}`,
	);
}

runner.dispose();

console.log(`\n${PASS} passed, ${FAIL} failed\n`);
process.exit(FAIL > 0 ? 1 : 0);
