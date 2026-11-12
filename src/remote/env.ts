// `ExecutionEnv` over one function, `run(script)` (run.ts): each file operation is one short POSIX
// sh script on the far side, with exact bytes both ways and the engine's error codes. The env never
// touches this machine's files. It is the phone's half of a worker that runs on another machine
// (TASKS.md item 20b); with `localRun` it runs here, which is how it is tested against
// `NodeExecutionEnv`.
//
// The far side needs sh, and GNU-style `stat -c`/`--printf`, `realpath -e`, `mktemp`, `tail -c`,
// `head -c`, `dd`, `find -mindepth/-maxdepth`: Linux and Termux have them; macOS does not.
// Paths resolve as the local env resolves them (relative to `cwd`); nothing confines them to a
// workspace: that is the sandbox's job.
import { randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, join, resolve } from "node:path/posix";
import { fileURLToPath } from "node:url";
import type { Context } from "@earendil-works/chord/context";
import {
	type BinaryReader, type DirReader, err, ExecutionError, type ExecutionEnv, type FileChange, FileError, type FileErrorCode, type FileInfo, type FileWatcher, LineScanner, type LineScan,
	ok, type Result, type ShellExecOptions, type ShellExecResult, StreamDecoder, type TextLine, type TextLineReader, type WatchTarget,
} from "@earendil-works/pi-durable/env";
import { abortError, q, type Run, type RunResult } from "./run.ts";

/** Files up to this size are read whole when opened, so a small `read` costs one round trip. */
const SMALL_FILE = 1024 * 1024;
/** What a text line reader asks for at a time from a larger file. */
const LINE_CHUNK = 1024 * 1024;
const MAX_TIMEOUT_MS = 2_147_483_647;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { ignoreBOM: true });

// Every script starts with this. `f code message` fails with an engine code (exit 3, the line on
// stderr); `t cmd...` runs a command with its stdout passed through and turns its error text into a
// code. The texts are the C library's, the same on glibc, musl and bionic.
const PRELUDE = `export LC_ALL=C
f() { printf '%s\\t%s' "$1" "$2" >&2; exit 3; }
c() { case "$1" in *"No such file"*) echo not_found;; *"ermission denied"*|*"not permitted"*) echo permission_denied;; *"Not a directory"*) echo not_directory;; *"Is a directory"*) echo is_directory;; *"subdirectory of itself"*|*"Invalid argument"*) echo invalid;; *) echo unknown;; esac; }
t() { _e=$("$@" 2>&1 >&3) || f "$(c "$_e")" "$_e"; } 3>&1
`;
/** Exec reports a command that could not start with this on stderr and exit 127, before any output. */
const MARK = "\u0001rho-exec:";
const CODES = new Set<FileErrorCode>(["aborted", "not_found", "permission_denied", "not_directory", "is_directory", "invalid", "not_supported", "unknown"]);

type Kind = FileInfo["kind"];
const KINDS: Record<string, Kind> = { "regular file": "file", "regular empty file": "file", directory: "directory", "symbolic link": "symlink" };
/** `stat` fields, in this order, for `parseInfo`. */
const STAT = "%F|%s|%.9Y";

function mtimeMs(stamp: string): number {
	const [seconds = "0", nanos = "0"] = stamp.split(".");
	return Number(seconds) * 1000 + Number(nanos.padEnd(9, "0")) / 1e6;
}
/** One `%F|%s|%.9Y` record; undefined for a kind the engine does not list. */
function parseInfo(record: string, path: string): FileInfo | undefined {
	const [type = "", size = "0", stamp = "0"] = record.split("|");
	const kind = KINDS[type];
	return kind && { name: basename(path), path, kind, size: Number(size), mtimeMs: mtimeMs(stamp) };
}
const aborted = (path?: string) => err<never, FileError>(new FileError("aborted", "aborted", path));
const closed = (what: string, path: string) => err<never, FileError>(new FileError("invalid", `${what} is closed`, path));
const isAbort = (error: unknown, signal?: AbortSignal) => signal?.aborted === true || (error instanceof Error && error.name === "AbortError");

export interface RemoteEnvOptions {
	run: Run;
	/** The working directory on the far side, absolute. */
	cwd: string;
	/** The far side's file namespace; equal ids must mean the same files. Default `remote`. */
	id?: string;
	/** The far side's home, for `~` paths. Default: asked once, when first needed. */
	home?: string;
}

/** The far side's files and shell, through `run`. `watch` is not supported. */
export class RemoteEnv implements ExecutionEnv {
	readonly id: string;
	cwd: string;
	readonly run: Run;
	#home: Promise<string> | undefined;
	readonly #running = new Set<AbortController>();

	constructor(options: RemoteEnvOptions) {
		this.run = options.run;
		this.cwd = options.cwd;
		this.id = options.id ?? "remote";
		if (options.home !== undefined) this.#home = Promise.resolve(options.home);
	}

	async #resolve(path: string): Promise<string> {
		let normalized = path;
		if (normalized === "~" || normalized.startsWith("~/")) {
			this.#home ??= this.run(`printf %s "$HOME"`).then((result) => decoder.decode(result.stdout));
			normalized = join(await this.#home, normalized.slice(2));
		} else if (normalized.startsWith("file://")) {
			try { normalized = fileURLToPath(normalized); } catch { /* an ordinary path, as the local env keeps it */ }
		}
		return isAbsolute(normalized) ? resolve(normalized) : resolve(this.cwd, normalized);
	}

	/** One script. Its stdout on success; an engine error otherwise. */
	async #op(script: string, path: string | undefined, context: Context, options: { stdin?: Uint8Array; onOutput?: (chunk: Uint8Array) => void } = {}): Promise<Result<Uint8Array, FileError>> {
		const signal = context.abortSignal;
		if (signal?.aborted) return aborted(path);
		let result: RunResult;
		try {
			result = await this.run(PRELUDE + script, { ...(options.stdin ? { stdin: options.stdin } : {}), ...(signal ? { signal } : {}), ...(options.onOutput ? { onOutput: (chunk, stream) => { if (stream === "stdout") options.onOutput!(chunk); } } : {}) });
		} catch (error) {
			if (isAbort(error, signal)) return aborted(path);
			return err(new FileError("unknown", `The far side could not be reached: ${(error as Error).message}`, path, error as Error));
		}
		if (signal?.aborted) return aborted(path);
		if (result.code === 0) return ok(result.stdout);
		const text = decoder.decode(result.stderr);
		const tab = text.indexOf("\t");
		const code = text.slice(0, tab) as FileErrorCode;
		if (result.code === 3 && tab > 0 && CODES.has(code)) return err(new FileError(code, text.slice(tab + 1).trim(), path));
		return err(new FileError("unknown", text.trim() || `exit ${result.code}`, path));
	}

	async absolutePath(path: string, _context: Context): Promise<Result<string, FileError>> {
		return ok(await this.#resolve(path));
	}
	async joinPath(parts: string[], _context: Context): Promise<Result<string, FileError>> {
		return ok(join(...parts));
	}

	async readBinaryFile(path: string, context: Context): Promise<Result<Uint8Array, FileError>> {
		const p = await this.#resolve(path);
		return this.#op(`[ -d ${q(p)} ] && f is_directory ${q(`Is a directory: ${p}`)}\nt cat -- ${q(p)}`, p, context);
	}
	async readTextFile(path: string, context: Context): Promise<Result<string, FileError>> {
		const bytes = await this.readBinaryFile(path, context);
		return bytes.ok ? ok(decoder.decode(bytes.value)) : bytes;
	}

	async #put(path: string, content: string | Uint8Array, append: boolean, context: Context): Promise<Result<void, FileError>> {
		const p = await this.#resolve(path);
		const bytes = typeof content === "string" ? encoder.encode(content) : content;
		const script = `t mkdir -p -- ${q(dirname(p))}\n[ -d ${q(p)} ] && f is_directory ${q(`Is a directory: ${p}`)}\n_e=$( { cat ${append ? ">>" : ">"} ${q(p)}; } 2>&1 ) || f "$(c "$_e")" "$_e"`;
		const result = await this.#op(script, p, context, { stdin: bytes });
		return result.ok ? ok(undefined) : result;
	}
	writeFile(path: string, content: string | Uint8Array, context: Context) { return this.#put(path, content, false, context); }
	appendFile(path: string, content: string | Uint8Array, context: Context) { return this.#put(path, content, true, context); }

	async truncateFile(path: string, size: number, context: Context): Promise<Result<void, FileError>> {
		const p = await this.#resolve(path);
		if (context.abortSignal?.aborted) return aborted(p);
		if (!Number.isSafeInteger(size) || size < 0) return err(new FileError("invalid", "File size must be a non-negative safe integer", p));
		const result = await this.#op(`[ -d ${q(p)} ] && f is_directory ${q(`Is a directory: ${p}`)}\n[ -e ${q(p)} ] || t stat -L -- ${q(p)}\nt dd if=/dev/null of=${q(p)} bs=1 seek=${size}`, p, context);
		return result.ok ? ok(undefined) : result;
	}
	async flushFile(path: string, context: Context): Promise<Result<void, FileError>> {
		const p = await this.#resolve(path);
		const result = await this.#op(`[ -d ${q(p)} ] && f is_directory ${q(`Is a directory: ${p}`)}\n[ -e ${q(p)} ] || t stat -L -- ${q(p)}\n[ -w ${q(p)} ] || f permission_denied ${q(`Permission denied: ${p}`)}\nsync -- ${q(p)} 2>/dev/null || sync`, p, context);
		return result.ok ? ok(undefined) : result;
	}

	/**
	 * rename(2) by its cases, as `mv` alone would move a file into a directory: a directory replaces
	 * only an empty directory, a file never replaces a directory, a symbolic link at the destination
	 * is replaced and not followed. Not atomic where it removes the destination first; across file
	 * systems it copies, where rename(2) refuses.
	 */
	async renameFile(sourcePath: string, destinationPath: string, context: Context): Promise<Result<void, FileError>> {
		const s = q(await this.#resolve(sourcePath));
		const d = q(await this.#resolve(destinationPath));
		const script = `[ -e ${s} ] || [ -L ${s} ] || t stat -- ${s}
sd=no; [ -d ${s} ] && [ ! -L ${s} ] && sd=yes
if [ -d ${d} ] && [ ! -L ${d} ]; then
  [ $sd = yes ] || f is_directory ${q(`Is a directory: ${destinationPath}`)}
  [ ${s} -ef ${d} ] && exit 0
  rmdir -- ${d} 2>/dev/null || f unknown ${q(`Directory not empty: ${destinationPath}`)}
elif [ -e ${d} ] || [ -L ${d} ]; then
  [ $sd = yes ] && f not_directory ${q(`Not a directory: ${destinationPath}`)}
  [ -L ${d} ] && rm -f -- ${d}
fi
t mv -f -- ${s} ${d}`;
		const result = await this.#op(script, await this.#resolve(sourcePath), context);
		return result.ok ? ok(undefined) : result;
	}

	async fileInfo(path: string, context: Context): Promise<Result<FileInfo, FileError>> {
		const p = await this.#resolve(path);
		const result = await this.#op(`t stat -c ${q(STAT)} -- ${q(p)}`, p, context);
		if (!result.ok) return result;
		const info = parseInfo(decoder.decode(result.value).trim(), p);
		return info ? ok(info) : err(new FileError("invalid", "Unsupported file type", p));
	}
	async exists(path: string, context: Context): Promise<Result<boolean, FileError>> {
		const result = await this.fileInfo(path, context);
		if (result.ok) return ok(true);
		if (result.error.code === "not_found") return ok(false);
		return err(result.error);
	}

	/** Checks that `p` is a directory this account can list, then runs `then`. */
	#inDir(p: string, then: string) {
		return `h=$(stat -L -c %F -- ${q(p)} 2>&1) || f "$(c "$h")" "$h"\n[ "$h" = directory ] || f not_directory ${q(`Not a directory: ${p}`)}\n[ -r ${q(p)} ] && [ -x ${q(p)} ] || f permission_denied ${q(`Permission denied: ${p}`)}\n${then}`;
	}
	/** `%F|%s|%.9Y|%n` records separated by NUL, as `stat --printf` writes them; entries of other kinds are left out. */
	#records(bytes: Uint8Array): FileInfo[] {
		const infos: FileInfo[] = [];
		for (const record of decoder.decode(bytes).split("\0")) {
			if (record === "") continue;
			const cut = record.indexOf("|", record.indexOf("|", record.indexOf("|") + 1) + 1);
			const info = parseInfo(record.slice(0, cut), record.slice(cut + 1));
			if (info) infos.push(info);
		}
		return infos;
	}
	async listDir(path: string, context: Context): Promise<Result<FileInfo[], FileError>> {
		const p = await this.#resolve(path);
		const result = await this.#op(this.#inDir(p, `find ${q(p)} -mindepth 1 -maxdepth 1 -exec stat --printf ${q(`${STAT}|%n\\0`)} -- {} + 2>/dev/null\nexit 0`), p, context);
		return result.ok ? ok(this.#records(result.value)) : result;
	}
	/** The names are listed when opened; each page reads their metadata, so an entry removed since is skipped. */
	async openDirReader(path: string, context: Context): Promise<Result<DirReader, FileError>> {
		const p = await this.#resolve(path);
		const listed = await this.#op(this.#inDir(p, `find ${q(p)} -mindepth 1 -maxdepth 1 -print0 2>/dev/null\nexit 0`), p, context);
		if (!listed.ok) return listed;
		const names = decoder.decode(listed.value).split("\0").filter(Boolean);
		let state: "open" | "closed" = "open";
		const env = this;
		return ok({
			async next(maxEntries: number, context: Context) {
				if (context.abortSignal?.aborted) return aborted(p);
				if (state === "closed") return closed("Directory reader", p);
				if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0) return err(new FileError("invalid", "maxEntries must be a positive safe integer", p));
				const page = names.splice(0, maxEntries);
				if (page.length === 0) return ok({ entries: [], done: true });
				const result = await env.#op(`stat --printf ${q(`${STAT}|%n\\0`)} -- ${page.map(q).join(" ")} 2>/dev/null\nexit 0`, p, context);
				if (!result.ok) { names.unshift(...page); return result; }
				return ok({ entries: env.#records(result.value), done: names.length === 0 });
			},
			async close() { state = "closed"; },
		});
	}

	async canonicalPath(path: string, context: Context): Promise<Result<string, FileError>> {
		const p = await this.#resolve(path);
		const result = await this.#op(`t realpath -e -- ${q(p)}`, p, context);
		return result.ok ? ok(decoder.decode(result.value).replace(/\n$/, "")) : result;
	}
	async createDir(path: string, options: { recursive?: boolean } | undefined, context: Context): Promise<Result<void, FileError>> {
		const p = await this.#resolve(path);
		const result = await this.#op(`t mkdir ${options?.recursive ?? true ? "-p " : ""}-- ${q(p)}`, p, context);
		return result.ok ? ok(undefined) : result;
	}
	async remove(path: string, options: { recursive?: boolean; force?: boolean } | undefined, context: Context): Promise<Result<void, FileError>> {
		const p = q(await this.#resolve(path));
		const missing = options?.force ? `exit 0` : `t stat -- ${p}`;
		// As the local env: a directory without `recursive` is refused with "unknown" (Node's ERR_FS_EISDIR).
		const script = `[ -e ${p} ] || [ -L ${p} ] || ${missing}
if [ -d ${p} ] && [ ! -L ${p} ]; then
  ${options?.recursive ? `t rm -rf -- ${p}` : `f unknown ${q(`Path is a directory: ${path}`)}`}
else
  t rm -f -- ${p}
fi`;
		const result = await this.#op(script, await this.#resolve(path), context);
		return result.ok ? ok(undefined) : result;
	}
	/** In the far side's `$TMPDIR` (else /tmp). */
	async createTempDir(prefix: string | undefined, context: Context): Promise<Result<string, FileError>> {
		const result = await this.#op(`t mktemp -d "\${TMPDIR:-/tmp}/"${q(prefix ?? "tmp-")}XXXXXX`, undefined, context);
		return result.ok ? ok(decoder.decode(result.value).replace(/\n$/, "")) : result;
	}
	async createTempFile(options: { prefix?: string; suffix?: string } | undefined, context: Context): Promise<Result<string, FileError>> {
		const name = q(`${options?.prefix ?? ""}${randomUUID()}${options?.suffix ?? ""}`);
		const result = await this.#op(`d=$(mktemp -d "\${TMPDIR:-/tmp}/tmp-XXXXXX" 2>&1) || f "$(c "$d")" "$d"\n_e=$( { : > "$d/"${name}; } 2>&1 ) || f "$(c "$_e")" "$_e"\nprintf '%s' "$d/"${name}`, undefined, context);
		return result.ok ? ok(decoder.decode(result.value)) : result;
	}

	/**
	 * A small regular file is read whole when opened: one round trip, and every later call sees the
	 * bytes it had then, renamed or not. A larger one is read by path in ranges; each read checks
	 * the path still names the file opened (device and inode) and fails with `invalid` when it does
	 * not, where a local open file would go on reading the file it opened.
	 */
	async openBinaryReader(path: string, options: { noFollow?: boolean } | undefined, context: Context): Promise<Result<BinaryReader, FileError>> {
		const p = await this.#resolve(path);
		const qp = q(p);
		const script = `${options?.noFollow ? `[ -L ${qp} ] && f invalid 'Refusing to follow a symbolic link'\n` : ""}h=$(stat -L -c ${q(`${STAT}|%d:%i`)} -- ${qp} 2>&1) || f "$(c "$h")" "$h"
case $h in directory\\|*) f is_directory ${q(`Is a directory: ${p}`)};; "regular file|"*|"regular empty file|"*) ;; *) f invalid 'Not a regular file';; esac
[ -r ${qp} ] || f permission_denied ${q(`Permission denied: ${p}`)}
printf '%s\\n' "$h"; s=\${h#*|}; s=\${s%%|*}
[ "$s" -le ${SMALL_FILE} ] && t cat -- ${qp}
exit 0`;
		const opened = await this.#op(script, p, context);
		if (!opened.ok) return opened;
		const newline = opened.value.indexOf(0x0a);
		const header = decoder.decode(opened.value.subarray(0, newline));
		const identity = header.slice(header.lastIndexOf("|") + 1);
		const info = parseInfo(header.slice(0, header.lastIndexOf("|")), p)!;
		const whole = info.size <= SMALL_FILE ? opened.value.slice(newline + 1) : undefined;
		const same = `[ "$(stat -L -c %d:%i -- ${qp} 2>/dev/null)" = ${q(identity)} ] || f invalid ${q(`${p} is no longer the file that was opened`)}\n`;
		let open = true;
		const env = this;
		return ok({
			async info(context: Context) {
				if (context.abortSignal?.aborted) return aborted(p);
				if (!open) return closed("Binary reader", p);
				if (whole) return ok({ ...info });
				const result = await env.#op(`${same}t stat -L -c ${q(STAT)} -- ${qp}`, p, context);
				return result.ok ? ok(parseInfo(decoder.decode(result.value).trim(), p)!) : result;
			},
			async read(offset: number, length: number, context: Context) {
				if (context.abortSignal?.aborted) return aborted(p);
				if (!open) return closed("Binary reader", p);
				if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0) return err(new FileError("invalid", "Offset and length must be non-negative safe integers", p));
				if (whole) return ok(whole.slice(offset, offset + length));
				if (length === 0) return ok(new Uint8Array(0));
				return env.#op(`${same}tail -c +${offset + 1} -- ${qp} | head -c ${length}`, p, context);
			},
			async scanLines(options: { startLine: number; endLine?: number }, context: Context): Promise<Result<LineScan, FileError>> {
				if (context.abortSignal?.aborted) return aborted(p);
				if (!open) return closed("Binary reader", p);
				let scanner: LineScanner;
				try { scanner = new LineScanner(options.startLine, options.endLine); } catch { return err(new FileError("invalid", "Invalid line range", p)); }
				if (whole) { scanner.push(whole); return ok(scanner.finish()); }
				const result = await env.#op(`${same}t cat -- ${qp}`, p, context, { onOutput: (chunk) => scanner.push(chunk) });
				return result.ok ? ok(scanner.finish()) : result;
			},
			async close() { open = false; },
		});
	}
	/** Over a binary reader; a directory is refused when opened, where the local env refuses its first line. */
	async openTextLineReader(path: string, context: Context): Promise<Result<TextLineReader, FileError>> {
		const opened = await this.openBinaryReader(path, undefined, context);
		if (!opened.ok) return opened;
		const reader = opened.value;
		const p = await this.#resolve(path);
		const stream = new StreamDecoder();
		let offset = 0;
		let buffered = "";
		let ended = false;
		let open = true;
		return ok({
			async readLine(context: Context): Promise<Result<TextLine | undefined, FileError>> {
				if (context.abortSignal?.aborted) return aborted(p);
				if (!open) return closed("Text line reader", p);
				while (true) {
					const newline = buffered.indexOf("\n");
					if (newline !== -1) {
						const text = buffered.slice(0, newline);
						buffered = buffered.slice(newline + 1);
						return ok({ text, terminated: true });
					}
					if (ended) {
						if (buffered === "") return ok(undefined);
						const text = buffered;
						buffered = "";
						return ok({ text, terminated: false });
					}
					const chunk = await reader.read(offset, LINE_CHUNK, context);
					if (!chunk.ok) return chunk;
					offset += chunk.value.length;
					if (chunk.value.length === 0) { buffered += stream.decode(); ended = true; } else buffered += stream.decode(chunk.value);
				}
			},
			async close(context: Context) { open = false; buffered = ""; await reader.close(context); },
		});
	}
	async readTextLines(path: string, options: { maxLines?: number } | undefined, context: Context): Promise<Result<string[], FileError>> {
		if (options?.maxLines !== undefined && options.maxLines <= 0) return ok([]);
		const opened = await this.openTextLineReader(path, context);
		if (!opened.ok) return opened;
		const lines: string[] = [];
		try {
			while (options?.maxLines === undefined || lines.length < options.maxLines) {
				const line = await opened.value.readLine(context);
				if (!line.ok) return line;
				if (line.value === undefined) break;
				lines.push(line.value.text);
			}
			return ok(lines);
		} finally {
			await opened.value.close(context);
		}
	}

	/** Not supported: the far side has no way yet to report changes. */
	async watch(_targets: readonly WatchTarget[], _onChange: (change: FileChange) => void, context: Context): Promise<Result<FileWatcher, FileError>> {
		if (context.abortSignal?.aborted) return aborted();
		return err(new FileError("not_supported", "Watching files is not supported on a remote machine"));
	}

	/**
	 * Runs through `run`: a string with the far side's bash (else sh), an argv directly. `window` is
	 * ignored (every chunk is delivered, as the local env does). A spill file is made on the far side,
	 * so the env's own `read` finds it; its bytes are sent there in batches as they arrive.
	 */
	async exec(command: string | readonly string[], options: ShellExecOptions | undefined, context: Context): Promise<Result<ShellExecResult, ExecutionError>> {
		const signal = context.abortSignal;
		if (signal?.aborted) return err(new ExecutionError("aborted", "aborted"));
		let timeoutMs: number | undefined;
		if (options?.timeout !== undefined) {
			if (!Number.isFinite(options.timeout) || options.timeout <= 0) return err(new ExecutionError("timeout", "Invalid timeout: must be a finite number of seconds"));
			timeoutMs = options.timeout * 1000;
			if (timeoutMs > MAX_TIMEOUT_MS) return err(new ExecutionError("timeout", `Invalid timeout: maximum is ${MAX_TIMEOUT_MS / 1000} seconds`));
		}
		if (typeof command !== "string" && command.length === 0) return err(new ExecutionError("spawn_error", "Empty argv: no program to run"));
		const cwd = options?.cwd ? await this.#resolve(options.cwd) : this.cwd;
		const vars = Object.entries(options?.env ?? {}).map(([key, value]) => q(`${key}=${value}`));
		const inherit = options?.inheritEnv ?? true;
		const envPrefix = !inherit ? `env -i ${vars.join(" ")} ` : vars.length > 0 ? `env ${vars.join(" ")} ` : "";
		const spawnFail = (why: string) => `{ printf '%s' ${q(`${MARK}${why}\u0001`)} >&2; exit 127; }`;
		const run = typeof command === "string"
			? `b=$(command -v bash 2>/dev/null) || b=sh\nexec ${envPrefix}"$b" -c ${q(command)}`
			: `command -v -- ${q(command[0]!)} >/dev/null 2>&1 || ${spawnFail("spawn")}\nexec ${envPrefix}${command.map(q).join(" ")}`;
		const script = `cd -- ${q(cwd)} 2>/dev/null || ${spawnFail("cwd")}\n${run}`;

		const controller = new AbortController();
		this.#running.add(controller);
		const onAbort = () => controller.abort();
		signal?.addEventListener("abort", onAbort, { once: true });
		let timedOut = false;
		const timer = timeoutMs === undefined ? undefined : setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
		const decoders = { stdout: new StreamDecoder(), stderr: new StreamDecoder() };
		let callbackError: ExecutionError | undefined;
		let settled = false;
		const emit = (text: string, stream: "stdout" | "stderr") => {
			if (settled || text === "" || !options?.onOutput || callbackError) return;
			try { options.onOutput(text, context, { stream }); } catch (error) {
				callbackError = new ExecutionError("callback_error", (error as Error).message, error as Error);
				controller.abort();
			}
		};
		// A spill: past either threshold, every byte so far and after goes to a file on the far side.
		const spill = options?.spill;
		let seenBytes = 0;
		let seenNewlines = 0;
		const held: Uint8Array[] = [];
		let heldBytes = 0;
		let spillPath: Promise<Result<string, FileError>> | undefined;
		let spillChain: Promise<unknown> = Promise.resolve();
		let spillError: FileError | undefined;
		const flushSpill = () => {
			if (!spillPath || heldBytes === 0) return;
			const batch = new Uint8Array(heldBytes);
			let at = 0;
			for (const chunk of held.splice(0)) { batch.set(chunk, at); at += chunk.length; }
			heldBytes = 0;
			const path = spillPath;
			spillChain = spillChain.then(async () => {
				const made = await path;
				if (!made.ok) { spillError ??= made.error; return; }
				const written = await this.appendFile(made.value, batch, { abortSignal: undefined } as Context);
				if (!written.ok) spillError ??= written.error;
			});
		};
		const keep = (chunk: Uint8Array) => {
			if (!spill || chunk.length === 0) return;
			held.push(chunk);
			heldBytes += chunk.length;
			if (!spillPath) {
				seenBytes += chunk.length;
				for (let index = chunk.indexOf(0x0a); index !== -1; index = chunk.indexOf(0x0a, index + 1)) seenNewlines++;
				const lines = seenNewlines + (chunk[chunk.length - 1] === 0x0a ? 0 : 1);
				if (seenBytes <= spill.afterBytes && lines <= spill.afterLines) return;
				spillPath = this.createTempFile({ prefix: "pi-output-", suffix: ".log" }, { abortSignal: undefined } as Context);
			}
			if (heldBytes >= 256 * 1024) flushSpill();
		};
		// Stderr is held until it cannot be the mark that says the command did not start.
		let markCheck = true;
		let pending = new Uint8Array(0);
		let spawnError: string | undefined;
		const onOutput = (chunk: Uint8Array, stream: "stdout" | "stderr") => {
			if (stream === "stderr" && markCheck) {
				const joined = new Uint8Array(pending.length + chunk.length);
				joined.set(pending);
				joined.set(chunk, pending.length);
				if (joined[0] === 1 && joined.indexOf(1, 1) === -1 && joined.length < 64) { pending = joined; return; }
				markCheck = false;
				pending = new Uint8Array(0);
				const text = decoder.decode(joined);
				if (text.startsWith(MARK) && text.indexOf("\u0001", 1) === text.length - 1) { spawnError = text.slice(MARK.length, -1); return; }
				chunk = joined;
			}
			keep(chunk);
			emit(decoders[stream].decode(chunk), stream);
		};
		const finish = (result: Result<ShellExecResult, ExecutionError>) => {
			settled = true;
			if (timer) clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			this.#running.delete(controller);
			return result;
		};
		let code: number;
		try {
			code = (await this.run(script, { signal: controller.signal, onOutput })).code;
		} catch (error) {
			flushSpill();
			await spillChain;
			const path = spillPath ? await spillPath : undefined;
			const interrupted = callbackError ?? (timedOut ? new ExecutionError("timeout", `timeout:${options?.timeout}`) : isAbort(error, controller.signal) ? new ExecutionError("aborted", "aborted") : new ExecutionError("unknown", `The far side could not be reached: ${(error as Error).message}`, error as Error));
			if (path?.ok && interrupted.code !== "callback_error") interrupted.spillPath = path.value;
			return finish(err(interrupted));
		}
		if (pending.length > 0) onOutput(new Uint8Array(0), "stderr");
		if (markCheck && pending.length > 0) { markCheck = false; keep(pending); emit(decoders.stderr.decode(pending), "stderr"); }
		emit(decoders.stdout.decode(), "stdout");
		emit(decoders.stderr.decode(), "stderr");
		flushSpill();
		await spillChain;
		if (callbackError) return finish(err(callbackError));
		if (spawnError !== undefined && code === 127) {
			return finish(err(new ExecutionError("spawn_error", spawnError === "cwd" ? `Working directory does not exist: ${cwd}\nCannot execute bash commands.` : `Program not found: ${String(command[0])}`)));
		}
		if (spillError) return finish(err(new ExecutionError("unknown", `Failed to preserve complete shell output: ${spillError.message}`, spillError)));
		const path = spillPath ? await spillPath : undefined;
		return finish(ok({ exitCode: code, ...(path?.ok ? { spillPath: path.value } : {}) }));
	}

	/** Ends every command this env still runs; for its owner's shutdown. */
	async cleanup(_context: Context): Promise<void> {
		for (const controller of this.#running) controller.abort();
		this.#running.clear();
	}
}

export { abortError };
