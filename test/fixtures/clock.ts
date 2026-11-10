// A clock a test can move. It runs at real speed from a chosen start, and `advance` jumps it
// forward. Timers armed on it fire when its time has come, so a sleep of hours ends the moment
// the test advances past it, while short pacing timers still fire by themselves.
export function fakeClock(start = Date.parse("2026-03-01T10:00:00Z"), offsetFile?: string) {
	let offset = start - Date.now();
	const extra = (): number => {
		if (!offsetFile) return 0;
		try {
			return Number(require("node:fs").readFileSync(offsetFile, "utf8")) || 0; // moved from another process
		} catch {
			return 0;
		}
	};
	const now = (): number => Date.now() + offset + extra();
	const setTimer = (callback: () => void, delayMs: number): (() => void) => {
		const at = now() + delayMs;
		const poll = setInterval(() => {
			if (now() < at) return;
			clearInterval(poll);
			callback();
		}, 10);
		poll.unref?.();
		return () => clearInterval(poll);
	};
	return { now, setTimer, advance: (ms: number) => void (offset += ms) };
}
export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
