// A command that outlives the connection and the process that started it, on top of `run`
// (run.ts). Each job is a directory on the far side, `<root>/jobs/<key>/`; making it is the lock,
// so one key never starts two copies. The command runs detached in its own process group, with
// stdin from /dev/null, stdout and stderr to files there, its pid in `pid` and, when it ends, its
// exit code in `exit`. Following it reads those files from byte offsets, so a dropped `run` or a
// restarted rho only asks again. Aborting a caller leaves the command running; `stop` ends it.
// TASKS.md item 20b, step 3.
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { StreamDecoder } from "@earendil-works/pi-durable/env";
import { bool, num, obj, opt, str } from "@earendil-works/pi-schema";
import { q, type Run, type RunResult } from "./run.ts";
import { RemoteEnv } from "./env.ts";

export interface JobOptions {
	/** Where the command runs, absolute, on the far side. Default: its home. */
	cwd?: string;
	/** Variables set for the command, over the far side's own. */
	env?: Record<string, string>;
	/** Seconds from the command's start (not from this call) after which it is stopped. */
	timeout?: number;
	/** Ends this call, not the command. */
	signal?: AbortSignal;
	/** Every byte of output from the start, in order per stream, once per call. */
	onOutput?: (chunk: Uint8Array, stream: "stdout" | "stderr") => void;
}
export type JobResult =
	/** It ended with `code`; `started` says whether this call started it. */
	| { status: "exited"; code: number; started: boolean }
	/** It is gone without an exit code: stopped, killed, or the machine restarted. */
	| { status: "stopped"; started: boolean }
	/** Its timeout passed: it was stopped. */
	| { status: "timeout"; started: boolean }
	/** This call was aborted; the command goes on. */
	| { status: "aborted"; started: boolean }
	/** The far side could not be reached; the command may still run. Ask again to reattach. */
	| { status: "unreachable"; started: boolean; error: string };

export interface Jobs {
	/** Start the job `key`, or attach to it if it exists, and follow it to its end. */
	job(key: string, command: string, options?: JobOptions): Promise<JobResult>;
	/** Signal its process group: TERM, then KILL after `graceMs`. True if it was running. */
	stop(key: string, options?: { graceMs?: number }): Promise<boolean>;
	/** Remove a finished job's directory; refused (false) while it runs. True if it is gone. */
	remove(key: string): Promise<boolean>;
}

export interface JobsOptions {
	run: Run;
	/** A directory on the far side; `$` and `~` are not expanded. */
	root: string;
	/** How often the far side looks at the files; default 200 ms. */
	pollMs?: number;
	/** How long one `run` follows before it returns and another is asked; default 20 s. */
	followMs?: number;
	/** Tries of a `run` that fails before the result is `unreachable`; default 3. */
	tries?: number;
	/** The wait between them; default 1 s. */
	retryMs?: number;
}

const KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const encoder = new TextEncoder();

// The job's runner, written into its directory. `$1` is the job's directory. It writes its own pid
// first: it leads the process group, so that pid is the group too.
const WRAPPER = `d=$1
echo $$ > "$d/pid.tmp" && mv -f "$d/pid.tmp" "$d/pid"
cd -- "$(cat "$d/cwd")" 2>/dev/null || { printf 'Working directory does not exist: %s\\n' "$(cat "$d/cwd")" > "$d/err"; echo 127 > "$d/exit.tmp"; mv -f "$d/exit.tmp" "$d/exit"; exit 0; }
b=$(command -v bash 2>/dev/null) || b=sh
"$b" "$d/cmd" < /dev/null > "$d/out" 2> "$d/err"
echo $? > "$d/exit.tmp"; mv -f "$d/exit.tmp" "$d/exit"
`;

/**
 * The far side's half of following: frames on stdout. `B <seconds since start>`, then
 * `O <stream> <length>` and that many bytes, as the files grow, then one of `X <code>` (ended),
 * `S` (gone without a code), `T` (this call's time is up, ask again).
 */
function follow(d: string, out: number, err: number, pollMs: number, followMs: number): string {
	const ticks = Math.max(1, Math.ceil(followMs / pollMs));
	const pause = (pollMs / 1000).toFixed(3);
	return `d=${q(d)}; o=${out}; e=${err}; n=0
s=$(cat "$d/started" 2>/dev/null) || s=$(date +%s)
printf 'B %s\\n' "$(( $(date +%s) - s ))"
boot=$(cat /proc/sys/kernel/random/boot_id 2>/dev/null)
drain() { z=$(wc -c < "$d/$1" 2>/dev/null) || z=0; z=$((z + 0)); [ "$z" -gt "$2" ] || return 1; printf 'O %s %s\\n' "$1" "$((z - $2))"; tail -c +$(($2 + 1)) "$d/$1" | head -c "$((z - $2))"; at=$z; }
alive() {
  if [ -f "$d/pid" ]; then
    [ -z "$boot" ] || [ "$(cat "$d/boot" 2>/dev/null)" = "$boot" ] || return 1
    kill -0 "$(cat "$d/pid")" 2>/dev/null
  else [ $(( $(date +%s) - s )) -lt 10 ]; fi
}
while :; do
  ended=; [ -f "$d/exit" ] && ended=yes
  drain out $o && o=$at
  drain err $e && e=$at
  if [ -n "$ended" ]; then printf 'X %s\\n' "$(cat "$d/exit")"; exit 0; fi
  if ! alive; then [ -f "$d/exit" ] && continue; printf 'S\\n'; exit 0; fi
  [ $n -ge ${ticks} ] && { printf 'T\\n'; exit 0; }
  n=$((n + 1)); sleep ${pause} 2>/dev/null || sleep 1
done`;
}

/** Make the job's directory and start it, or say it was there: `N` (new) or `R` (there). The command is stdin. */
function start(d: string, cwd: string | undefined): string {
	return `d=${q(d)}
mkdir -p -- "$(dirname -- "$d")" || exit 4
if mkdir -- "$d" 2>/dev/null; then
  cat > "$d/cmd"; : > "$d/out"; : > "$d/err"
  ${cwd === undefined ? `printf '%s' "$HOME"` : `printf '%s' ${q(cwd)}`} > "$d/cwd"
  cat /proc/sys/kernel/random/boot_id > "$d/boot" 2>/dev/null
  date +%s > "$d/started"
  printf '%s' ${q(WRAPPER)} > "$d/wrapper"
  if command -v setsid >/dev/null 2>&1; then setsid sh "$d/wrapper" "$d" < /dev/null > /dev/null 2>&1 &
  else (trap '' HUP; set -m; sh "$d/wrapper" "$d" < /dev/null > /dev/null 2>&1 &) fi
  printf 'N\\n'
else printf 'R\\n'; fi
`;
}

/** Parses frames from the far side as they arrive. */
class Frames {
	#buffer = new Uint8Array(0);
	#want: { stream: "stdout" | "stderr"; left: number } | undefined;
	end: { kind: "X"; code: number } | { kind: "S" | "T" } | undefined;
	started?: boolean;
	since?: number;
	constructor(readonly offsets: { out: number; err: number }, readonly onOutput?: (chunk: Uint8Array, stream: "stdout" | "stderr") => void) {}
	push(chunk: Uint8Array) {
		const joined = new Uint8Array(this.#buffer.length + chunk.length);
		joined.set(this.#buffer);
		joined.set(chunk, this.#buffer.length);
		let at = 0;
		while (at < joined.length) {
			if (this.#want) {
				const take = Math.min(this.#want.left, joined.length - at);
				const bytes = joined.slice(at, at + take);
				at += take;
				this.#want.left -= take;
				// Counted as it arrives: a frame cut off by a dropped link resumes where its bytes stopped.
				if (this.#want.stream === "stdout") this.offsets.out += take; else this.offsets.err += take;
				this.onOutput?.(bytes, this.#want.stream);
				if (this.#want.left === 0) this.#want = undefined;
				continue;
			}
			const newline = joined.indexOf(0x0a, at);
			if (newline === -1) break;
			const [kind, a, b] = new TextDecoder().decode(joined.subarray(at, newline)).split(" ");
			at = newline + 1;
			if (kind === "N" || kind === "R") this.started = kind === "N";
			else if (kind === "B") this.since = Number(a);
			else if (kind === "O") this.#want = { stream: a === "out" ? "stdout" : "stderr", left: Number(b) };
			else if (kind === "X") this.end = { kind: "X", code: Number(a) };
			else if (kind === "S" || kind === "T") this.end = { kind };
		}
		this.#buffer = joined.slice(at);
	}
}

export function createJobs(options: JobsOptions): Jobs {
	const { run } = options;
	const pollMs = options.pollMs ?? 200;
	const followMs = options.followMs ?? 20_000;
	const tries = options.tries ?? 3;
	const retryMs = options.retryMs ?? 1000;
	const dirOf = (key: string) => {
		if (!KEY.test(key)) throw new Error(`Not a job key: ${JSON.stringify(key)}`);
		return `${options.root.replace(/\/+$/, "")}/jobs/${key}`;
	};
	const stop = async (key: string, stopOptions: { graceMs?: number } = {}) => {
		const d = q(dirOf(key));
		const grace = Math.max(1, Math.ceil((stopOptions.graceMs ?? 2000) / 100));
		const result = await run(`d=${d}; [ -f "$d/pid" ] && [ ! -f "$d/exit" ] || exit 1
p=$(cat "$d/pid"); kill -s 0 -- "-$p" 2>/dev/null || exit 1
kill -s TERM -- "-$p" 2>/dev/null; i=0
while kill -s 0 -- "-$p" 2>/dev/null && [ $i -lt ${grace} ]; do sleep 0.1 2>/dev/null || sleep 1; i=$((i + 1)); done
kill -s KILL -- "-$p" 2>/dev/null; exit 0`);
		return result.code === 0;
	};
	return {
		stop,
		async remove(key) {
			const d = q(dirOf(key));
			const result = await run(`d=${d}; [ -d "$d" ] || exit 0
if [ ! -f "$d/exit" ] && [ -f "$d/pid" ] && kill -0 "$(cat "$d/pid")" 2>/dev/null; then exit 1; fi
rm -rf -- "$d"`);
			return result.code === 0;
		},
		async job(key, command, jobOptions = {}) {
			const d = dirOf(key);
			const { signal } = jobOptions;
			const offsets = { out: 0, err: 0 };
			const vars = Object.entries(jobOptions.env ?? {}).map(([name, value]) => {
				if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`Not a variable name: ${name}`);
				return `export ${name}=${q(value)}\n`;
			}).join("");
			let started: boolean | undefined;
			let deadline: number | undefined;
			let failures = 0;
			let first = true;
			while (true) {
				if (signal?.aborted) return { status: "aborted", started: started ?? false };
				const frames = new Frames(offsets, jobOptions.onOutput);
				let result: RunResult;
				try {
					// Never follow past the timeout, so it is kept to about one poll.
					const window = deadline === undefined ? (jobOptions.timeout === undefined ? followMs : Math.max(pollMs, Math.min(followMs, jobOptions.timeout * 1000))) : Math.max(pollMs, Math.min(followMs, deadline - Date.now()));
					const script = (first ? start(d, jobOptions.cwd) : "") + follow(d, offsets.out, offsets.err, pollMs, window);
					result = await run(script, { ...(first ? { stdin: encoder.encode(vars + command) } : {}), ...(signal ? { signal } : {}), onOutput: (chunk, stream) => { if (stream === "stdout") frames.push(chunk); } });
				} catch (error) {
					if (frames.started !== undefined) { started ??= frames.started; first = false; }
					if (signal?.aborted) return { status: "aborted", started: started ?? false };
					if (++failures >= tries) return { status: "unreachable", started: started ?? false, error: (error as Error).message };
					await Bun.sleep(retryMs);
					continue;
				}
				if (frames.started !== undefined) { started ??= frames.started; first = false; }
				if (first) return { status: "unreachable", started: false, error: `The job could not be made (exit ${result.code})` };
				if (jobOptions.timeout !== undefined && frames.since !== undefined) deadline ??= Date.now() + (jobOptions.timeout - frames.since) * 1000;
				const end = frames.end;
				if (end?.kind !== "X" && end?.kind !== "S" && deadline !== undefined && Date.now() >= deadline) {
					await stop(key).catch(() => false);
					return { status: "timeout", started: started ?? false };
				}
				if (end?.kind === "X") return { status: "exited", code: end.code, started: started ?? false };
				if (end?.kind === "S") return { status: "stopped", started: started ?? false };
				if (end === undefined) {
					if (++failures >= tries) return { status: "unreachable", started: started ?? false, error: `The far side ended the follow early (exit ${result.code})` };
					await Bun.sleep(retryMs);
					continue;
				}
				failures = 0;
			}
		},
	};
}

const bashSchema = obj({
	command: str({ description: "Bash command to execute" }),
	timeout: opt(num({ description: "Timeout in seconds (optional, no default timeout)" })),
}, { open: true });
const outputSchema = obj({ output: str(), truncated: bool(), exitCode: num() }, { open: true });

/**
 * A `bash` whose command is a job keyed by the tool task's id, so it is `replay: "safe"`: a rerun
 * after a restart attaches to the command the first run started, or collects its end. Aborting it
 * (a stop and a shutdown look alike) leaves the command running. It works where the call's env is
 * a `RemoteEnv`, through that env's `run`. A finished job's directory is kept: removing it before
 * the result is committed would let a rerun start the command again. Installed nowhere by default.
 */
export function jobBashTool(options: { root: string; name?: string; prefix?: string } & Omit<JobsOptions, "run" | "root">): ToolRegistration<typeof bashSchema> {
	return defineTool({
		name: options.name ?? "bash",
		description: "Execute a bash command in the current working directory. Returns combined stdout and stderr. The command keeps running if the connection drops, and is collected when asked again. Optionally provide a timeout in seconds.",
		parameters: bashSchema,
		structuredOutputSchema: outputSchema,
		outputLimits: { retain: "tail" },
		replay: "safe",
		async execute(args, api, context) {
			const env = api.env;
			if (!(env instanceof RemoteEnv)) throw new Error("This bash runs only where the conversation's environment is a remote one");
			const jobs = createJobs({ ...options, run: env.run });
			const decoders = { stdout: new StreamDecoder(), stderr: new StreamDecoder() };
			const result = await jobs.job(`${options.prefix ?? "t"}${String(api.taskId)}`, args.command, {
				cwd: env.cwd,
				...(args.timeout === undefined ? {} : { timeout: args.timeout }),
				...(context.abortSignal ? { signal: context.abortSignal } : {}),
				onOutput: (chunk, stream) => { const text = decoders[stream].decode(chunk); if (text) api.output(text); },
			});
			for (const stream of ["stdout", "stderr"] as const) { const rest = decoders[stream].decode(); if (rest) api.output(rest); }
			if (result.status === "aborted") throw new Error("Command aborted; it goes on running on the far side");
			if (result.status === "timeout") throw new Error(`Command timed out after ${args.timeout} seconds`);
			if (result.status === "stopped") throw new Error("The command stopped without an exit code (it was stopped, killed, or the machine restarted)");
			if (result.status === "unreachable") throw new Error(`The machine could not be reached: ${result.error}. The command may still be running.`);
			const retained = api.retainedOutput();
			const structuredOutput = { output: retained.text, truncated: retained.truncated, exitCode: result.code };
			if (result.code === 0) return { structuredOutput };
			return { structuredOutput, isError: true, diagnostics: [{ severity: "error" as const, code: "exit_code", message: `Command exited with code ${result.code}` }] };
		},
	});
}
