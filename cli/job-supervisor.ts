/**
 * Daemon-owned job supervisor. Jev admits a job from its prompt and the
 * load already running. The interactive session never calls this.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isPidRunning } from "../extensions/lib/file-lock.ts";
import {
	type Job,
	deadRunningJobs,
	jobsDir,
	listJobs,
	readJobSlotCap,
	selectJobsToStart,
	updateJob,
} from "../extensions/lib/jobs.ts";
import { parseInitToml } from "./config.ts";
import { askJev } from "./job-admission.ts";
import { buildPiChildEnv, resolveRhoPaths } from "./rho-paths.ts";

const RESULT_MARK = "RHO_JOB_RESULT:";
const QUESTION_MARK = "RHO_JOB_QUESTION:";

function readJevSettings(home: string): {
	enabled?: unknown;
	apiKeyEnv?: unknown;
} {
	try {
		const initPath = path.join(resolveRhoPaths(home).rhoDir, "init.toml");
		const jev = parseInitToml(fs.readFileSync(initPath, "utf-8")).settings.jev;
		return { enabled: jev?.enabled, apiKeyEnv: jev?.api_key_env };
	} catch {
		return {};
	}
}

export interface JobSupervisor {
	stop: () => void;
}

function runnerPrompt(job: Job): string {
	return [
		`You are a Rho job runner for ${job.id}.`,
		"Do the job below. Do not delegate. Do not message the user directly.",
		"If you need the user, stop and end with one line: RHO_JOB_QUESTION: <question>",
		"When finished, end with one line: RHO_JOB_RESULT: <summary>",
		job.result ? `Previous note:\n${job.result}` : "",
		job.prompt,
	]
		.filter((line) => line !== "")
		.join("\n");
}

function markerValue(text: string, mark: string): string | null {
	const line = text
		.split("\n")
		.map((item) => item.trim())
		.reverse()
		.find((item) => item.startsWith(mark));
	if (!line) return null;
	const value = line.slice(mark.length).trim();
	return value || null;
}

function spawnRunner(
	job: Job,
	piBin: string,
	home: string,
	onExit: (id: string) => void,
): number {
	const paths = resolveRhoPaths(home);
	const promptPath = path.join(jobsDir(paths.rhoDir), `${job.id}.prompt.txt`);
	fs.mkdirSync(jobsDir(paths.rhoDir), { recursive: true });
	fs.writeFileSync(promptPath, runnerPrompt(job), "utf-8");
	const child = spawn(piBin, ["-p", "--no-session", `@${promptPath}`], {
		cwd: job.cwd,
		env: {
			...buildPiChildEnv(paths),
			RHO_SUBAGENT: "1",
			RHO_JOB_ID: job.id,
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	let output = "";
	const append = (chunk: Buffer) => {
		output = `${output}${chunk.toString("utf-8")}`.slice(-20_000);
	};
	child.stdout?.on("data", append);
	child.stderr?.on("data", append);
	const pid = child.pid;
	if (!pid) throw new Error(`failed to spawn runner for ${job.id}`);
	child.on("close", (code) => {
		onExit(job.id);
		try {
			fs.unlinkSync(promptPath);
		} catch {
			/* prompt already removed */
		}
		void finishRunner(paths.rhoDir, job.id, code ?? 1, output);
	});
	return pid;
}

async function finishRunner(
	rhoDir: string,
	id: string,
	code: number,
	output: string,
): Promise<void> {
	const current = listJobs(rhoDir).find((job) => job.id === id);
	if (!current || current.status !== "running") return;
	const question = markerValue(output, QUESTION_MARK);
	if (question) {
		await updateJob(rhoDir, id, {
			status: "waiting_input",
			question,
			pid: null,
			notify: "pending",
		});
		return;
	}
	if (code === 0) {
		const result =
			markerValue(output, RESULT_MARK) ??
			output.trim().split("\n").filter(Boolean).slice(-1)[0] ??
			"finished";
		await updateJob(rhoDir, id, {
			status: "succeeded",
			result: result.slice(0, 2000),
			pid: null,
			notify: "pending",
		});
		return;
	}
	await updateJob(rhoDir, id, {
		status: "failed",
		error: (output.trim().slice(-500) || `exit ${code}`).slice(0, 2000),
		pid: null,
		notify: "pending",
	});
}

export function startJobSupervisor(opts: {
	piBin: string | null;
	home?: string;
	intervalMs?: number;
}): JobSupervisor {
	const home = opts.home ?? process.env.HOME ?? os.homedir();
	const rhoDir = resolveRhoPaths(home).rhoDir;
	const localPids = new Map<string, number>();
	let stopped = false;
	let ticking = false;

	const tick = async () => {
		if (stopped || ticking) return;
		ticking = true;
		try {
			for (const job of deadRunningJobs(listJobs(rhoDir), (pid) => {
				if ([...localPids.values()].includes(pid)) return true;
				return isPidRunning(pid);
			})) {
				if (localPids.has(job.id)) continue;
				await updateJob(rhoDir, job.id, {
					status: "failed",
					error: "runner exited without a result",
					pid: null,
					notify: "pending",
				});
			}
			if (!opts.piBin) return;
			const jobs = listJobs(rhoDir);
			const starting = await selectJobsToStart({
				queued: jobs.filter((job) => job.status === "queued"),
				running: jobs.filter((job) => job.status === "running"),
				machine: {
					cpus: os.availableParallelism?.() ?? os.cpus().length,
					loadavg1: os.loadavg()[0] ?? 0,
					freeMemBytes: os.freemem(),
					totalMemBytes: os.totalmem(),
				},
				cap: readJobSlotCap(),
				ask: (state) =>
					askJev(state, process.env, fetch, readJevSettings(home)),
			});
			for (const job of starting) {
				if (localPids.has(job.id)) continue;
				const pid = spawnRunner(job, opts.piBin, home, (id) => {
					localPids.delete(id);
				});
				localPids.set(job.id, pid);
				await updateJob(rhoDir, job.id, {
					status: "running",
					pid,
					notify: "pending",
				});
			}
		} finally {
			ticking = false;
		}
	};

	const timer = setInterval(() => {
		void tick();
	}, opts.intervalMs ?? 3000);
	timer.unref?.();
	void tick();

	return {
		stop() {
			stopped = true;
			clearInterval(timer);
			for (const [id, pid] of localPids) {
				try {
					process.kill(pid, "SIGTERM");
				} catch {
					/* already gone */
				}
				void updateJob(rhoDir, id, {
					status: "cancelled",
					pid: null,
					notify: "suppressed",
				});
			}
			localPids.clear();
		},
	};
}
