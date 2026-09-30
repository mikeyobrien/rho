/**
 * Durable jobs for the Rho daemon.
 *
 * The interactive session enqueues work. The daemon supervisor runs it.
 * Chat must not become the fallback runner.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isPidRunning, withFileLock } from "./file-lock.ts";

export type JobStatus =
	| "queued"
	| "running"
	| "waiting_input"
	| "succeeded"
	| "failed"
	| "cancelled";

export type JobNotify = "pending" | "sent" | "suppressed";

export interface Job {
	id: string;
	title: string;
	prompt: string;
	cwd: string;
	status: JobStatus;
	question: string | null;
	result: string | null;
	error: string | null;
	createdAt: string;
	updatedAt: string;
	pid: number | null;
	notify: JobNotify;
}

interface CreatedEvent {
	type: "created";
	id: string;
	title: string;
	prompt: string;
	cwd: string;
	createdAt: string;
}

interface UpdateEvent {
	type: "update";
	id: string;
	at: string;
	status?: JobStatus;
	question?: string | null;
	result?: string | null;
	error?: string | null;
	pid?: number | null;
	notify?: JobNotify;
}

type JobEvent = CreatedEvent | UpdateEvent;

/** Below this, another process cannot start. This is a veto, not a slot count. */
export const JOB_MEMORY_VETO_BYTES = 512 * 1024 * 1024;
/** Reserved in the load snapshot for a job admitted earlier in the same tick. */
export const JOB_ADMITTED_FOOTPRINT_BYTES = 512 * 1024 * 1024;
export const ADMISSION_CONFIDENCE = 0.6;

export function jobsDir(rhoDir: string): string {
	return path.join(rhoDir, "jobs");
}

export function jobsPath(rhoDir: string): string {
	return path.join(jobsDir(rhoDir), "jobs.jsonl");
}

export function jobLockPath(rhoDir: string): string {
	return path.join(jobsDir(rhoDir), "jobs.lock");
}

export function daemonPidPath(home = os.homedir()): string {
	return path.join(home, ".rho-daemon.pid");
}

export interface MachineLoad {
	cpus: number;
	loadavg1: number;
	freeMemBytes: number;
	totalMemBytes: number;
}

export interface AdmissionState {
	candidate: { id: string; title: string; prompt: string; cwd: string };
	running: { id: string; title: string; prompt: string; cwd: string }[];
	admittedThisTick: number;
	machine: MachineLoad;
}

export type AdmissionChoice = "start" | "wait";

/** Route through Jev only when the setting is on and a key is present. */
export function jevRoute(input: {
	enabled: boolean;
	hasApiKey: boolean;
}): boolean {
	return input.enabled && input.hasApiKey;
}

export function readJevEnabled(value: unknown): boolean {
	if (value === undefined || value === null) return true;
	return value === true;
}

export function readJobSlotCap(
	env: NodeJS.ProcessEnv = process.env,
): number | null {
	const raw = env.RHO_JOB_SLOTS?.trim();
	if (!raw) return null;
	const n = Number(raw);
	if (!Number.isFinite(n) || n < 0) return 0;
	return Math.floor(n);
}

export function memoryVeto(freeMemBytes: number): boolean {
	return freeMemBytes < JOB_MEMORY_VETO_BYTES;
}

function preview(text: string, max = 500): string {
	const trimmed = text.trim();
	return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)}…`;
}

export function buildAdmissionState(
	job: Job,
	running: Job[],
	machine: MachineLoad,
	admittedThisTick = 0,
): AdmissionState {
	const footprint = admittedThisTick * JOB_ADMITTED_FOOTPRINT_BYTES;
	return {
		candidate: {
			id: job.id,
			title: job.title,
			prompt: preview(job.prompt, 2000),
			cwd: job.cwd,
		},
		running: running.map((item) => ({
			id: item.id,
			title: item.title,
			prompt: preview(item.prompt),
			cwd: item.cwd,
		})),
		admittedThisTick,
		machine: {
			...machine,
			freeMemBytes: Math.max(0, machine.freeMemBytes - footprint),
		},
	};
}

export function interpretAdmission(answer: {
	choice?: string;
	confidence?: number;
}): AdmissionChoice {
	if (answer.choice !== "start") return "wait";
	if (
		typeof answer.confidence !== "number" ||
		answer.confidence < ADMISSION_CONFIDENCE
	) {
		return "wait";
	}
	return "start";
}

export async function selectJobsToStart(input: {
	queued: Job[];
	running: Job[];
	machine: MachineLoad;
	cap: number | null;
	ask: (state: AdmissionState) => Promise<AdmissionChoice | "unavailable">;
}): Promise<Job[]> {
	const selected: Job[] = [];
	const running = [...input.running];
	const ordered = [...input.queued].sort((a, b) =>
		a.createdAt.localeCompare(b.createdAt),
	);
	for (const job of ordered) {
		const active = running.length + selected.length;
		if (input.cap != null && active >= input.cap) break;
		const state = buildAdmissionState(
			job,
			running,
			input.machine,
			selected.length,
		);
		if (memoryVeto(state.machine.freeMemBytes)) break;
		const choice = await input.ask(state);
		if (choice !== "start") break;
		selected.push(job);
		running.push({ ...job, status: "running" });
	}
	return selected;
}

function ensureJobsDir(rhoDir: string): void {
	fs.mkdirSync(jobsDir(rhoDir), { recursive: true });
}

function readEvents(rhoDir: string): JobEvent[] {
	const file = jobsPath(rhoDir);
	if (!fs.existsSync(file)) return [];
	const events: JobEvent[] = [];
	for (const line of fs.readFileSync(file, "utf-8").split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			events.push(JSON.parse(trimmed) as JobEvent);
		} catch {
			/* skip a corrupt line rather than hiding later jobs */
		}
	}
	return events;
}

export function foldJobs(events: JobEvent[]): Job[] {
	const byId = new Map<string, Job>();
	for (const event of events) {
		if (event.type === "created") {
			byId.set(event.id, {
				id: event.id,
				title: event.title,
				prompt: event.prompt,
				cwd: event.cwd,
				status: "queued",
				question: null,
				result: null,
				error: null,
				createdAt: event.createdAt,
				updatedAt: event.createdAt,
				pid: null,
				notify: "pending",
			});
			continue;
		}
		const current = byId.get(event.id);
		if (!current) continue;
		if (event.status) current.status = event.status;
		if (event.question !== undefined) current.question = event.question;
		if (event.result !== undefined) current.result = event.result;
		if (event.error !== undefined) current.error = event.error;
		if (event.pid !== undefined) current.pid = event.pid;
		if (event.notify) current.notify = event.notify;
		current.updatedAt = event.at;
	}
	return [...byId.values()].sort((a, b) =>
		a.createdAt.localeCompare(b.createdAt),
	);
}

export function listJobs(rhoDir: string): Job[] {
	return foldJobs(readEvents(rhoDir));
}

function appendEvent(rhoDir: string, event: JobEvent): void {
	ensureJobsDir(rhoDir);
	fs.appendFileSync(jobsPath(rhoDir), `${JSON.stringify(event)}\n`, "utf-8");
}

async function locked<T>(rhoDir: string, fn: () => Promise<T>): Promise<T> {
	ensureJobsDir(rhoDir);
	return withFileLock(jobLockPath(rhoDir), { purpose: "jobs" }, fn);
}

function newJobId(): string {
	return `job-${crypto.randomBytes(4).toString("hex")}`;
}

function normalizeKey(title: string, prompt: string): string {
	return `${title.trim().toLowerCase()}\n${prompt.trim()}`;
}

export function daemonIsUp(
	home = os.homedir(),
	pidAlive: (pid: number) => boolean = isPidRunning,
): boolean {
	try {
		const pid = Number(fs.readFileSync(daemonPidPath(home), "utf-8").trim());
		return Number.isFinite(pid) && pidAlive(pid);
	} catch {
		return false;
	}
}

export function delegateMessage(
	id: string,
	title: string,
	daemonUp: boolean,
): string {
	const base = `Queued ${id} "${title}". Reply with the id and stop. Do not poll. Do not do this job in the chat.`;
	if (daemonUp) return base;
	return `${base} The rho daemon is down, so it stays queued until \`rho start\`.`;
}

export async function delegateJob(
	rhoDir: string,
	input: { title: string; prompt: string; cwd: string },
	opts: { daemonUp: boolean; now?: Date } = { daemonUp: false },
): Promise<{ job: Job; created: boolean; text: string }> {
	const title = input.title.trim();
	const prompt = input.prompt.trim();
	const cwd = input.cwd.trim() || process.cwd();
	if (!title) throw new Error("title required");
	if (!prompt) throw new Error("prompt required");
	const now = (opts.now ?? new Date()).toISOString();
	return locked(rhoDir, async () => {
		const existing = listJobs(rhoDir).find(
			(job) =>
				(job.status === "queued" || job.status === "running") &&
				normalizeKey(job.title, job.prompt) === normalizeKey(title, prompt),
		);
		if (existing) {
			return {
				job: existing,
				created: false,
				text: delegateMessage(existing.id, existing.title, opts.daemonUp),
			};
		}
		const id = newJobId();
		appendEvent(rhoDir, {
			type: "created",
			id,
			title,
			prompt,
			cwd,
			createdAt: now,
		});
		const job = listJobs(rhoDir).find((item) => item.id === id);
		if (!job) throw new Error(`failed to read ${id}`);
		return {
			job,
			created: true,
			text: delegateMessage(id, title, opts.daemonUp),
		};
	});
}

export async function updateJob(
	rhoDir: string,
	id: string,
	patch: Omit<UpdateEvent, "type" | "id" | "at"> & { at?: string },
): Promise<Job> {
	return locked(rhoDir, async () => {
		const current = listJobs(rhoDir).find((job) => job.id === id);
		if (!current) throw new Error(`unknown job ${id}`);
		appendEvent(rhoDir, {
			type: "update",
			id,
			at: patch.at ?? new Date().toISOString(),
			...patch,
		});
		const next = listJobs(rhoDir).find((job) => job.id === id);
		if (!next) throw new Error(`failed to read ${id}`);
		return next;
	});
}

export async function replyToJob(
	rhoDir: string,
	id: string,
	answer: string,
): Promise<Job> {
	const text = answer.trim();
	if (!text) throw new Error("reply required");
	return locked(rhoDir, async () => {
		const current = listJobs(rhoDir).find((job) => job.id === id);
		if (!current) throw new Error(`unknown job ${id}`);
		if (current.status !== "waiting_input") {
			throw new Error(`${id} is ${current.status}, not waiting_input`);
		}
		const at = new Date().toISOString();
		appendEvent(rhoDir, {
			type: "update",
			id,
			at,
			status: "queued",
			question: null,
			result: `User reply: ${text}`,
			pid: null,
			notify: "pending",
		});
		const next = listJobs(rhoDir).find((job) => job.id === id);
		if (!next) throw new Error(`failed to read ${id}`);
		return next;
	});
}

export async function cancelJob(rhoDir: string, id: string): Promise<Job> {
	return locked(rhoDir, async () => {
		const current = listJobs(rhoDir).find((job) => job.id === id);
		if (!current) throw new Error(`unknown job ${id}`);
		if (
			current.status === "succeeded" ||
			current.status === "failed" ||
			current.status === "cancelled"
		) {
			return current;
		}
		appendEvent(rhoDir, {
			type: "update",
			id,
			at: new Date().toISOString(),
			status: "cancelled",
			pid: null,
			notify: "suppressed",
		});
		const next = listJobs(rhoDir).find((job) => job.id === id);
		if (!next) throw new Error(`failed to read ${id}`);
		return { ...next, pid: current.pid };
	});
}

export function deadRunningJobs(
	jobs: Job[],
	pidAlive: (pid: number) => boolean,
): Job[] {
	return jobs.filter(
		(job) =>
			job.status === "running" && (job.pid == null || !pidAlive(job.pid)),
	);
}

export function buildWorkPrompt(jobs: Job[]): string {
	const running = jobs.filter((job) => job.status === "running").length;
	const waiting = jobs.filter((job) => job.status === "waiting_input");
	const lines = [
		"## Work",
		`${running} running. ${waiting.length} waiting for you.`,
	];
	for (const job of waiting.slice(0, 5)) {
		lines.push(`- ${job.id} "${job.title}": ${job.question ?? "input needed"}`);
	}
	lines.push(
		"You are the conversation. Delegate a requested multi-step job, reply with its id, and stop. Do not poll. Do not use rho_subagent unless the user asked for a visible pane. If the daemon is down, the job stays queued until `rho start`. Do not do the job yourself.",
	);
	return lines.join("\n");
}

export function formatJob(job: Job): string {
	const lines = [`${job.id} ${job.status} ${job.title}`, `cwd: ${job.cwd}`];
	if (job.question) lines.push(`question: ${job.question}`);
	if (job.result) lines.push(`result: ${job.result}`);
	if (job.error) lines.push(`error: ${job.error}`);
	return lines.join("\n");
}

export function pendingNotices(jobs: Job[]): Job[] {
	return jobs.filter(
		(job) =>
			job.notify === "pending" &&
			(job.status === "succeeded" ||
				job.status === "failed" ||
				job.status === "waiting_input"),
	);
}

export function noticeText(job: Job): string {
	if (job.status === "waiting_input") {
		return `${job.id} needs you: ${job.question ?? job.title}`;
	}
	if (job.status === "failed") {
		return `${job.id} failed: ${job.error ?? job.title}`;
	}
	return `${job.id} finished: ${job.result ?? job.title}`;
}

export async function handleDelegate(
	rhoDir: string,
	params: { title?: string; prompt?: string; cwd?: string },
	opts: { daemonUp: boolean; cwd: string },
): Promise<{ text: string; error: boolean }> {
	try {
		const result = await delegateJob(
			rhoDir,
			{
				title: params.title ?? "",
				prompt: params.prompt ?? "",
				cwd: params.cwd?.trim() || opts.cwd,
			},
			{ daemonUp: opts.daemonUp },
		);
		return { text: result.text, error: false };
	} catch (error) {
		return {
			text: error instanceof Error ? error.message : String(error),
			error: true,
		};
	}
}

export async function handleJobAction(
	rhoDir: string,
	params: { action?: string; id?: string; answer?: string },
): Promise<{ text: string; error: boolean; killPid?: number | null }> {
	const action = params.action?.trim();
	try {
		if (action === "list") {
			const jobs = listJobs(rhoDir);
			if (jobs.length === 0) return { text: "No jobs.", error: false };
			return {
				text: jobs
					.map((job) => `${job.id} ${job.status} ${job.title}`)
					.join("\n"),
				error: false,
			};
		}
		if (action === "show") {
			const id = params.id?.trim();
			if (!id) return { text: "id required", error: true };
			const job = listJobs(rhoDir).find((item) => item.id === id);
			if (!job) return { text: `unknown job ${id}`, error: true };
			return { text: formatJob(job), error: false };
		}
		if (action === "reply") {
			const id = params.id?.trim();
			if (!id) return { text: "id required", error: true };
			const job = await replyToJob(rhoDir, id, params.answer ?? "");
			return { text: `${job.id} queued`, error: false };
		}
		if (action === "cancel") {
			const id = params.id?.trim();
			if (!id) return { text: "id required", error: true };
			const before = listJobs(rhoDir).find((item) => item.id === id);
			const job = await cancelJob(rhoDir, id);
			return {
				text: `${job.id} cancelled`,
				error: false,
				killPid: before?.status === "running" ? before.pid : null,
			};
		}
		return { text: "action must be list, show, reply, or cancel", error: true };
	} catch (error) {
		return {
			text: error instanceof Error ? error.message : String(error),
			error: true,
		};
	}
}

export async function markNoticesSent(
	rhoDir: string,
	ids: string[],
): Promise<void> {
	for (const id of ids) {
		await updateJob(rhoDir, id, { notify: "sent" });
	}
}
