// The one thing a place that runs a worker's tools has to offer: run a POSIX sh script there.
// `RemoteEnv` (env.ts) and the jobs (jobs.ts) are built on it and nothing else, so a transport
// (SSH, a daemon, a local shell) only has to carry a script, its stdin and its output.
import { spawn } from "node:child_process";
import { constants } from "node:os";

export interface RunOptions {
	/** Bytes for the script's stdin, exactly; absent: stdin is empty. */
	stdin?: Uint8Array;
	/** Aborting it ends the script and everything it started in its process group, and `run` rejects. */
	signal?: AbortSignal;
	/** Each chunk as it arrives. When given, the result's `stdout` and `stderr` are empty. */
	onOutput?: (chunk: Uint8Array, stream: "stdout" | "stderr") => void;
}

export interface RunResult {
	/** The script's exit code; killed by a signal: 128 + its number. */
	code: number;
	stdout: Uint8Array;
	stderr: Uint8Array;
}

/**
 * Run `script` with a POSIX `sh` on the far side. Output is bytes, exactly as written. Rejects only
 * when the transport fails (the link dropped, the shell could not start) or `signal` aborted: a
 * script that fails is a result with its code.
 */
export type Run = (script: string, options?: RunOptions) => Promise<RunResult>;

/** Quote a string for sh: every byte but NUL survives. */
export const q = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

export function abortError(): Error {
	const error = new Error("aborted");
	error.name = "AbortError";
	return error;
}

function concat(chunks: Uint8Array[]): Uint8Array {
	if (chunks.length === 1) return chunks[0]!;
	const out = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
	let at = 0;
	for (const chunk of chunks) { out.set(chunk, at); at += chunk.length; }
	return out;
}

/** `Run` on this machine: `sh -c script` in its own process group. For tests, and for the phone as a place. */
export function localRun(options: { shell?: string } = {}): Run {
	return (script, run = {}) => new Promise((resolve, reject) => {
		if (run.signal?.aborted) { reject(abortError()); return; }
		const child = spawn(options.shell ?? "sh", ["-c", script], { detached: true, stdio: [run.stdin ? "pipe" : "ignore", "pipe", "pipe"] });
		const out: Uint8Array[] = [];
		const err: Uint8Array[] = [];
		let aborted = false;
		const kill = () => {
			aborted = true;
			try { process.kill(-child.pid!, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch { /* gone */ } }
		};
		run.signal?.addEventListener("abort", kill, { once: true });
		child.stdin?.on("error", () => {});
		child.stdin?.end(run.stdin);
		child.stdout!.on("data", (chunk: Buffer) => { const bytes = new Uint8Array(chunk); run.onOutput ? run.onOutput(bytes, "stdout") : out.push(bytes); });
		child.stderr!.on("data", (chunk: Buffer) => { const bytes = new Uint8Array(chunk); run.onOutput ? run.onOutput(bytes, "stderr") : err.push(bytes); });
		child.on("error", (error) => { run.signal?.removeEventListener("abort", kill); reject(error); });
		child.on("close", (code, signal) => {
			run.signal?.removeEventListener("abort", kill);
			if (aborted) { reject(abortError()); return; }
			resolve({ code: code ?? (signal ? 128 + (constants.signals[signal] ?? 0) : 1), stdout: concat(out), stderr: concat(err) });
		});
	});
}
