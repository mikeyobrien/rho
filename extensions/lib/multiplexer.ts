/**
 * Rho uses one multiplexer. Herdr, when selected, owns every background pane.
 */
import { spawnSync } from "node:child_process";

export const HERDR_SESSION = "rho";

export type Multiplexer = "herdr" | "tmux";

export function resolveMultiplexer(input: {
	requested?: string | null;
	herdrAvailable: boolean;
}): { host: Multiplexer; error?: string } {
	const raw = (input.requested ?? "").trim().toLowerCase();
	if (raw === "tmux") return { host: "tmux" };
	if (raw === "herdr") {
		if (!input.herdrAvailable) {
			return { host: "herdr", error: "Herdr is the session host, but `herdr` is not on PATH." };
		}
		return { host: "herdr" };
	}
	if (raw && raw !== "auto") {
		return { host: "tmux", error: `Unknown session host '${raw}'.` };
	}
	return { host: input.herdrAvailable ? "herdr" : "tmux" };
}

export function herdrArgv(args: readonly string[]): string[] {
	return ["--session", HERDR_SESSION, ...args];
}

export interface CommandResult {
	status: number | null;
	stdout: string;
	stderr: string;
}

export type CommandRunner = (args: readonly string[]) => CommandResult;

export function tabIdByLabel(stdout: string, label: string): string | null {
	try {
		const parsed = JSON.parse(stdout) as {
			result?: { tabs?: Array<{ label?: string; tab_id?: string }> };
		};
		return parsed.result?.tabs?.find((tab) => tab.label === label)?.tab_id ?? null;
	} catch {
		return null;
	}
}

export function createdPaneId(stdout: string): string | null {
	try {
		const parsed = JSON.parse(stdout) as {
			result?: { root_pane?: { pane_id?: string } };
		};
		const id = parsed.result?.root_pane?.pane_id;
		return typeof id === "string" && id.length > 0 ? id : null;
	} catch {
		return null;
	}
}

export function runHerdrPane(input: {
	label: string;
	command: string;
	cwd: string;
	replace?: boolean;
	run: CommandRunner;
}): { ok: boolean; target?: string; error?: string } {
	if (input.replace) {
		const listed = input.run(herdrArgv(["tab", "list"]));
		const existing = tabIdByLabel(listed.stdout, input.label);
		if (existing) input.run(herdrArgv(["tab", "close", existing]));
	}

	const created = input.run(
		herdrArgv([
			"tab",
			"create",
			"--label",
			input.label,
			"--cwd",
			input.cwd,
			"--no-focus",
		]),
	);
	const paneId = createdPaneId(created.stdout);
	if (created.status !== 0 || !paneId) {
		return {
			ok: false,
			error: created.stderr.trim() || "Failed to create a Herdr pane",
		};
	}

	const ran = input.run(herdrArgv(["pane", "run", paneId, input.command]));
	if (ran.status !== 0) {
		return { ok: false, error: ran.stderr.trim() || "Failed to run the Herdr command" };
	}
	return { ok: true, target: `${HERDR_SESSION}:${input.label}` };
}

export function herdrSpawn(): CommandRunner {
	return (args) => {
		const result = spawnSync("herdr", args, { encoding: "utf-8" });
		return {
			status: result.status,
			stdout: result.stdout || "",
			stderr: result.stderr || "",
		};
	};
}
