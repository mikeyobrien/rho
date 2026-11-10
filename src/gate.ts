// The release gate: how new code gets into the running rho.
//
// Rho runs from one checkout (the release checkout) and work happens in another. A release
// takes one commit from the work checkout and:
//   1. checks it, in a clean copy, before anything is switched;
//   2. waits for rho to be idle, switches the release checkout to it, and restarts rho;
//   3. checks that the rho now running is that commit;
//   4. if it is not, goes back to the commit that ran before and restarts that.
// The gate looks at the commit and the running process itself. It takes nobody's word.
// It runs in its own process, because the restart ends the rho that asked for it.
import { spawn } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface GateHost {
	/** The checkout rho runs from. */
	releaseDir: string;
	/** Where `release.json` is written. */
	dataDir: string;
	/** Run in a checkout after it changes, e.g. to fetch packages. */
	install: string[];
	/** Must exit 0 for a commit to be released. */
	check: string[];
	stop(): Promise<void>;
	start(): Promise<void>;
	/** True once the rho that is running is `commit`. */
	healthy(commit: string): Promise<boolean>;
	/** True when rho has a model it can use. Absent: not asked. */
	ready?(): Promise<boolean>;
	/** True when no run is working. Absent: do not wait. */
	idle?(): Promise<boolean>;
	/** Tell the conversation how it went. `key` is the same for a repeat of the same news. */
	notify(text: string, key: string): Promise<void>;
	log(line: string): void;
	checkTimeoutMs?: number;
	healthTimeoutMs?: number;
	idleTimeoutMs?: number;
}
export type Outcome = {
	/** released: the new commit runs. refused, failed: nothing changed. rolled-back: the old commit runs again. down: neither runs. */
	status: "released" | "refused" | "failed" | "rolled-back" | "down";
	commit?: string;
	previous?: string;
	reason?: string;
	at: number;
};

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
/** Run a command to its end. On a timeout its whole process group is killed, so nothing it started holds on. */
function sh(command: string[], cwd: string, timeoutMs = 60_000): Promise<{ code: number; out: string }> {
	return new Promise((done) => {
		const child = spawn(command[0]!, command.slice(1), { cwd, detached: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
		let out = "";
		let timedOut = false;
		const keep = (chunk: Buffer) => void (out = (out + chunk.toString()).slice(-200_000));
		child.stdout.on("data", keep);
		child.stderr.on("data", keep);
		const timer = setTimeout(() => {
			timedOut = true;
			try {
				process.kill(-child.pid!, "SIGKILL");
			} catch {
				child.kill("SIGKILL");
			}
		}, timeoutMs);
		child.on("error", (error) => (clearTimeout(timer), done({ code: 127, out: error.message })));
		child.on("close", (code) => (clearTimeout(timer), done({ code: timedOut ? 124 : (code ?? 1), out: out.trim() })));
	});
}
const git = (cwd: string, ...args: string[]) => sh(["git", ...args], cwd);
const short = (commit: string | undefined) => (commit ?? "").slice(0, 7);
const tail = (text: string, lines = 30) => text.split("\n").slice(-lines).join("\n");

/** What can be said before any work: the commit to release and the one running, or why not. */
export async function preflight(releaseDir: string, source: string, ref: string): Promise<{ commit: string; previous: string; source: string } | { refused: string }> {
	const head = await git(releaseDir, "rev-parse", "HEAD");
	if (head.code !== 0) return { refused: `Rho does not run from a git checkout (${releaseDir}), so there is nothing to switch.` };
	const top = await git(source, "rev-parse", "--show-toplevel");
	if (top.code !== 0) return { refused: "Run this inside the git checkout the work was committed in." };
	if (realpathSync(top.out) === realpathSync(releaseDir)) return { refused: "This is the checkout rho runs from. Work in another checkout (a clone or a worktree) and release from there." };
	const commit = await git(source, "rev-parse", "--verify", "--quiet", `${ref}^{commit}`);
	if (commit.code !== 0) return { refused: `No such commit: ${ref}` };
	if (commit.out === head.out) return { refused: `Rho already runs ${short(head.out)}.` };
	const dirty = await git(releaseDir, "status", "--porcelain", "--untracked-files=no");
	if (dirty.out !== "") return { refused: `The checkout rho runs from has uncommitted changes, so it is not switched:\n${tail(dirty.out, 10)}` };
	return { commit: commit.out, previous: head.out, source: top.out };
}

const NO_MODEL = "Rho came up without a model it can use. An API key that was only in the environment of the shell that started rho is not there after a restart rho starts itself. Store it with: rho key <provider>";
/** Release `ref` of the checkout at `source`. Resolves with what happened; it does not throw for a failed release. */
export async function release(host: GateHost, source: string, ref = "HEAD"): Promise<Outcome> {
	const done = async (outcome: Omit<Outcome, "at">, news?: string): Promise<Outcome> => {
		const result = { ...outcome, at: Date.now() };
		writeFileSync(join(host.dataDir, "release.json"), `${JSON.stringify(result, null, "\t")}\n`, { mode: 0o600 });
		host.log(`release: ${result.status}${result.reason ? `: ${result.reason.split("\n")[0]}` : ""}`);
		if (news) await host.notify(`[release gate] ${news}`, `release:${short(result.commit)}:${result.status}`).catch((error) => host.log(`release: could not report: ${(error as Error).message}`));
		return result;
	};
	const checked = await preflight(host.releaseDir, source, ref);
	if ("refused" in checked) return done({ status: "refused", reason: checked.refused });
	const { commit, previous } = checked;
	const stage = (name: string) => {
		host.log(`release ${short(commit)}: ${name}`);
		writeFileSync(join(host.dataDir, "release.json"), `${JSON.stringify({ status: "running", stage: name, commit, previous, pid: process.pid, at: Date.now() }, null, "\t")}\n`, { mode: 0o600 });
	};
	const unchanged = (reason: string) => done({ status: "failed", commit, previous, reason }, `${short(commit)} was not released, and rho still runs ${short(previous)}. ${reason}`);

	// 1. Bring the commit over. A ref in the work checkout makes it fetchable whatever branch it is on.
	stage("fetch");
	await git(checked.source, "update-ref", "refs/rho/candidate", commit);
	const fetched = await git(host.releaseDir, "fetch", "--no-tags", "--quiet", checked.source, "+refs/rho/candidate:refs/rho/candidate");
	const got = await git(host.releaseDir, "rev-parse", "--verify", "--quiet", "refs/rho/candidate");
	if (fetched.code !== 0 || got.out !== commit) return unchanged(`The commit could not be fetched: ${tail(fetched.out, 5)}`);

	// 2. Check it in a clean copy. Nothing running has changed yet.
	stage("check");
	const copy = mkdtempSync(join(tmpdir(), "rho-release-"));
	let failure: string | undefined;
	try {
		const added = await git(host.releaseDir, "worktree", "add", "--detach", "--force", copy, commit);
		if (added.code !== 0) failure = `A clean copy could not be made: ${tail(added.out, 5)}`;
		else {
			const installed = await sh(host.install, copy, 300_000);
			if (installed.code !== 0) failure = `Its packages could not be installed:\n${tail(installed.out)}`;
			else {
				const result = await sh(host.check, copy, host.checkTimeoutMs ?? 600_000);
				if (result.code !== 0) failure = `Its checks failed (${result.code === 124 ? "timed out" : `exit ${result.code}`}):\n${tail(result.out)}`;
			}
		}
	} finally {
		await git(host.releaseDir, "worktree", "remove", "--force", copy);
		rmSync(copy, { recursive: true, force: true });
		await git(host.releaseDir, "worktree", "prune");
	}
	if (failure) return unchanged(failure);

	// 3. Switch when rho is idle, so no answer is cut off. A run that goes on too long is not waited for:
	//    it is resumed by the rho that starts.
	if (host.idle) {
		stage("wait for idle");
		const until = Date.now() + (host.idleTimeoutMs ?? 120_000);
		while (Date.now() < until && !(await host.idle().catch(() => true))) await sleep(500);
	}
	const switchTo = async (target: string): Promise<string | undefined> => {
		const out = await git(host.releaseDir, "checkout", "--detach", "--quiet", target);
		if (out.code !== 0) return tail(out.out, 5);
		const installed = await sh(host.install, host.releaseDir, 300_000);
		return installed.code === 0 ? undefined : tail(installed.out);
	};
	const restart = async (target: string): Promise<boolean> => {
		await host.stop().catch((error) => host.log(`release: stop: ${(error as Error).message}`));
		await host.start().catch((error) => host.log(`release: start: ${(error as Error).message}`));
		const until = Date.now() + (host.healthTimeoutMs ?? 60_000);
		while (Date.now() < until) {
			if (await host.healthy(target).catch(() => false)) return true;
			await sleep(250);
		}
		return false;
	};
	stage("switch");
	const switched = await switchTo(commit);
	if (switched !== undefined) {
		const back = await switchTo(previous); // rho has not been restarted: it still runs the old code from memory
		if (back !== undefined) host.log(`release: could not restore the checkout: ${back}`);
		return unchanged(`The checkout could not be switched: ${switched}`);
	}
	// A rho started by hand got its API keys from that shell's environment. The gate, started by
	// rho, does not have them, so the rho it starts may come up with no model. Going back would
	// not help: the old commit would be started the same way. So it is said, not undone.
	const wasReady = host.ready ? await host.ready().catch(() => false) : false;
	stage("restart");
	if (await restart(commit)) {
		const lost = wasReady && !(await host.ready!().catch(() => true));
		if (lost) host.log("release: rho had a model before the restart and has none now");
		return done({ status: "released", commit, previous, ...(lost ? { reason: NO_MODEL } : {}) }, `Rho now runs ${short(commit)} (it ran ${short(previous)}). Its checks passed and the restarted rho answered.${lost ? ` ${NO_MODEL}` : ""}`);
	}

	// 4. It did not come up as the new commit: go back.
	stage("roll back");
	const reason = `After the switch, rho did not come up as ${short(commit)}.`;
	const back = await switchTo(previous);
	if (back === undefined && (await restart(previous))) return done({ status: "rolled-back", commit, previous, reason }, `${short(commit)} passed its checks but did not start, so rho is back on ${short(previous)}. Look at the log for why.`);
	return done({ status: "down", commit, previous, reason: `${reason} Going back to ${short(previous)} failed too${back ? `: ${back}` : "."}` });
}
