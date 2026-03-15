import { type PtyHandle, TerminalManager } from "../web/terminal-manager.ts";

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

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

class FakePty implements PtyHandle {
	pid = 4242;
	writes: string[] = [];
	resizes: Array<{ cols: number; rows: number }> = [];
	killed = 0;
	private readonly dataListeners = new Set<(data: string) => void>();
	private readonly exitListeners = new Set<
		(event: { exitCode: number; signal?: number }) => void
	>();

	write(data: string): void {
		this.writes.push(data);
	}

	resize(cols: number, rows: number): void {
		this.resizes.push({ cols, rows });
	}

	kill(): void {
		this.killed += 1;
	}

	onData(listener: (data: string) => void): { dispose(): void } {
		this.dataListeners.add(listener);
		return {
			dispose: () => {
				this.dataListeners.delete(listener);
			},
		};
	}

	onExit(listener: (event: { exitCode: number; signal?: number }) => void): {
		dispose(): void;
	} {
		this.exitListeners.add(listener);
		return {
			dispose: () => {
				this.exitListeners.delete(listener);
			},
		};
	}

	emitData(data: string): void {
		for (const listener of this.dataListeners) {
			listener(data);
		}
	}

	emitExit(exitCode: number, signal?: number): void {
		for (const listener of this.exitListeners) {
			listener({ exitCode, signal });
		}
	}
}

console.log("\n=== Terminal Manager Tests ===\n");

console.log("-- create session forwards PTY output and normalizes metadata --");
{
	let fakePty: FakePty | null = null;
	const manager = new TerminalManager((shell, _args, options) => {
		assert(shell.length > 0, "shell is resolved for PTY create");
		assertEq(options.name, "xterm-256color", "TERM name is xterm-256color");
		assertEq(options.cols, 80, "requested cols forwarded to PTY factory");
		assertEq(options.rows, 24, "requested rows forwarded to PTY factory");
		fakePty = new FakePty();
		return fakePty;
	});

	const session = manager.createSession({ cols: 80, rows: 24 });
	assertEq(manager.listSessions().length, 1, "session is tracked after create");
	assertEq(session.pid, 4242, "session exposes PTY pid");

	const seen: string[] = [];
	manager.subscribe(session.id, (event) => {
		if (event.type === "data") {
			seen.push(event.data);
		}
	});

	fakePty?.emitData("hello");
	assertEq(seen.join(""), "hello", "pty data is forwarded to subscribers");
	assertEq(
		manager.getReplay(session.id),
		"hello",
		"session replay captures PTY output",
	);
}

console.log("\n-- write and resize commands reach PTY handle --");
{
	const fakePty = new FakePty();
	const manager = new TerminalManager(() => fakePty);
	const session = manager.createSession({ cols: 90, rows: 30 });

	manager.write(session.id, "ls -la\r");
	manager.resize(session.id, 120, 40);

	assertEq(fakePty.writes[0], "ls -la\r", "write forwards input bytes");
	assertEq(fakePty.resizes.length, 1, "resize reaches PTY once");
	assertEq(fakePty.resizes[0]?.cols, 120, "resize forwards cols");
	assertEq(fakePty.resizes[0]?.rows, 40, "resize forwards rows");
}

console.log("\n-- explicit close emits exit and removes session --");
{
	const fakePty = new FakePty();
	const manager = new TerminalManager(() => fakePty);
	const session = manager.createSession();
	let exitSignal: number | null = null;

	manager.subscribe(session.id, (event) => {
		if (event.type === "exit") {
			exitSignal = event.signal;
		}
	});

	assertEq(
		manager.close(session.id),
		true,
		"close returns true for active session",
	);
	assertEq(exitSignal, 15, "close emits synthetic SIGTERM-style exit event");
	assertEq(manager.listSessions().length, 0, "session is removed after close");
	assertEq(fakePty.killed, 1, "close kills the PTY handle");
}

console.log("\n-- PTY exit event cleans up tracked session --");
{
	const fakePty = new FakePty();
	const manager = new TerminalManager(() => fakePty);
	const session = manager.createSession();
	let exitCode: number | null = null;

	manager.subscribe(session.id, (event) => {
		if (event.type === "exit") {
			exitCode = event.exitCode;
		}
	});

	fakePty.emitExit(7);
	assertEq(exitCode, 7, "exit event forwards PTY exit code");
	assertEq(
		manager.getSession(session.id),
		null,
		"session is removed after PTY exit",
	);
}

console.log(
	"\n-- unsubscribed sessions stay alive until idle ttl, then expire --",
);
{
	const fakePty = new FakePty();
	const manager = new TerminalManager(() => fakePty, { idleTtlMs: 40 });
	const session = manager.createSession();
	const unsubscribe = manager.subscribe(session.id, () => {});
	unsubscribe();

	assert(
		manager.getSession(session.id) !== null,
		"session still exists immediately after unsubscribe",
	);
	await sleep(70);
	assertEq(
		manager.getSession(session.id),
		null,
		"session expires after idle ttl",
	);
	assertEq(fakePty.killed, 1, "idle expiry kills the PTY handle");
}

console.log("\n-- re-subscribing before idle ttl cancels pending cleanup --");
{
	const fakePty = new FakePty();
	const manager = new TerminalManager(() => fakePty, { idleTtlMs: 80 });
	const session = manager.createSession();
	const unsubscribeA = manager.subscribe(session.id, () => {});
	unsubscribeA();
	await sleep(20);
	const unsubscribeB = manager.subscribe(session.id, () => {});
	await sleep(90);
	assert(
		manager.getSession(session.id) !== null,
		"re-subscribing cancels idle expiry",
	);
	unsubscribeB();
	await sleep(100);
	assertEq(
		manager.getSession(session.id),
		null,
		"session expires after final unsubscribe",
	);
}

console.log(`\n=== Results: ${PASS} passed, ${FAIL} failed ===\n`);
process.exit(FAIL > 0 ? 1 : 0);
