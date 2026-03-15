import fs from "node:fs";
import path from "node:path";
import { bindTerminalTouchScroll } from "../web/public/js/terminal-touch.js";

function assert(condition: boolean, label: string): void {
	if (!condition) {
		throw new Error(`Assertion failed: ${label}`);
	}
	console.log(`✓ ${label}`);
}

function assertEq<T>(actual: T, expected: T, label: string): void {
	if (actual !== expected) {
		throw new Error(
			`Assertion failed: ${label}\nExpected: ${JSON.stringify(expected)}\nActual: ${JSON.stringify(actual)}`,
		);
	}
	console.log(`✓ ${label}`);
}

type FakeTouch = { clientY: number };
type FakeEvent = {
	touches?: FakeTouch[];
	preventDefault?: () => void;
};

class FakeElement {
	dataset: Record<string, string> = {};
	clientHeight = 240;
	private listeners = new Map<string, Array<(event: FakeEvent) => void>>();

	addEventListener(type: string, cb: (event: FakeEvent) => void): void {
		const handlers = this.listeners.get(type) ?? [];
		handlers.push(cb);
		this.listeners.set(type, handlers);
	}

	dispatch(type: string, event: FakeEvent): void {
		for (const handler of this.listeners.get(type) ?? []) {
			handler(event);
		}
	}
}

console.log("\n=== Web Terminal Touch Tests ===\n");

{
	const root = new FakeElement();
	const scrollCalls: number[] = [];
	let focusCount = 0;
	const term = {
		scrollLines: (amount: number) => {
			scrollCalls.push(amount);
		},
	};

	bindTerminalTouchScroll({
		surfaceEl: root,
		getTerm: () => term,
		getRows: () => 24,
		focus: () => {
			focusCount += 1;
		},
	});

	let prevented = false;
	root.dispatch("touchstart", { touches: [{ clientY: 100 }] });
	root.dispatch("touchmove", {
		touches: [{ clientY: 125 }],
		preventDefault: () => {
			prevented = true;
		},
	});
	root.dispatch("touchend", {});

	assert(prevented, "dragging inside terminal prevents native touch scroll");
	assertEq(scrollCalls.length, 1, "single drag emits one scroll command");
	assertEq(
		scrollCalls[0],
		-2,
		"downward drag scrolls terminal upward into history",
	);
	assertEq(focusCount, 0, "dragging does not refocus terminal as a tap");
}

{
	const root = new FakeElement();
	let focusCount = 0;

	bindTerminalTouchScroll({
		surfaceEl: root,
		getTerm: () => ({ scrollLines: () => {} }),
		getRows: () => 24,
		focus: () => {
			focusCount += 1;
		},
	});

	root.dispatch("touchstart", { touches: [{ clientY: 100 }] });
	root.dispatch("touchmove", {
		touches: [{ clientY: 103 }],
		preventDefault: () => {
			throw new Error("tap-sized movement should not prevent default");
		},
	});
	root.dispatch("touchend", {});

	assertEq(focusCount, 1, "tap-sized touch still focuses terminal input");
}

{
	const root = new FakeElement();
	const scrollCalls: number[] = [];
	const term = {
		scrollLines: (amount: number) => {
			scrollCalls.push(amount);
		},
	};

	bindTerminalTouchScroll({
		surfaceEl: root,
		getTerm: () => term,
		getRows: () => 24,
	});
	bindTerminalTouchScroll({
		surfaceEl: root,
		getTerm: () => term,
		getRows: () => 24,
	});

	root.dispatch("touchstart", { touches: [{ clientY: 100 }] });
	root.dispatch("touchmove", {
		touches: [{ clientY: 120 }],
		preventDefault: () => {},
	});

	assertEq(
		scrollCalls.length,
		1,
		"binding twice does not duplicate touch handlers",
	);
}

{
	const repoRoot = path.resolve(import.meta.dirname, "..");
	const ptrSource = fs.readFileSync(
		path.join(repoRoot, "web/public/js/pull-to-refresh.js"),
		"utf8",
	);
	const cssSource = fs.readFileSync(
		path.join(repoRoot, "web/public/css/terminal-drawer.css"),
		"utf8",
	);
	const terminalCoreSource = fs.readFileSync(
		path.join(repoRoot, "web/public/js/terminal-core.js"),
		"utf8",
	);

	assert(
		ptrSource.includes('closest?.(".terminal-drawer-root")'),
		"pull-to-refresh ignores terminal touch targets",
	);
	assert(
		cssSource.includes("overscroll-behavior: contain;"),
		"terminal drawer CSS contains touch scroll containment rules",
	);
	assert(
		terminalCoreSource.includes("bindTerminalTouchScroll") &&
			terminalCoreSource.includes("surfaceEl: this.term.canvas"),
		"terminal core wires touch scroll binding to the canvas surface",
	);
}
