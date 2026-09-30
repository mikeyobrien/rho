/**
 * Choose Rho's persistent session host.
 * Herdr wins when it is installed unless the user forces tmux.
 */

export type SessionHost = "herdr" | "tmux";

export const HERDR_SESSION = "rho";
export const HERDR_AGENT = "rho";
export const HERDR_WORKSPACE_LABEL = "rho";

/** Dedicated session name. Tests set RHO_HERDR_SESSION so they never touch the live rho session. */
export function herdrSessionName(env: NodeJS.ProcessEnv = process.env): string {
	const raw = (env.RHO_HERDR_SESSION || HERDR_SESSION).trim();
	if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(raw)) return HERDR_SESSION;
	return raw;
}

export function resolveSessionHost(input: {
	requested?: string | null;
	herdrAvailable: boolean;
}): { host: SessionHost; error?: string } {
	const raw = (input.requested ?? "").trim().toLowerCase();
	if (raw === "tmux") return { host: "tmux" };
	if (raw === "herdr") {
		if (!input.herdrAvailable) {
			return {
				host: "herdr",
				error: "Session host is herdr, but `herdr` is not on PATH.",
			};
		}
		return { host: "herdr" };
	}
	if (raw && raw !== "auto") {
		return { host: "tmux", error: `Unknown session host '${raw}'. Use auto, herdr, or tmux.` };
	}
	return { host: input.herdrAvailable ? "herdr" : "tmux" };
}

export function herdrAttachCommand(session = herdrSessionName()): string {
	return `herdr --session ${session}`;
}

export function parseHerdrServerRunning(stdout: string): boolean {
	try {
		const parsed = JSON.parse(stdout) as { running?: boolean };
		return parsed.running === true;
	} catch {
		return false;
	}
}

export function paneIdFromWorkspaceCreate(stdout: string): string | null {
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

export function workspaceIdByLabel(stdout: string, label: string): string | null {
	try {
		const parsed = JSON.parse(stdout) as {
			result?: { workspaces?: Array<{ label?: string; workspace_id?: string }> };
		};
		const match = parsed.result?.workspaces?.find((workspace) => workspace.label === label);
		return match?.workspace_id ?? null;
	} catch {
		return null;
	}
}

function findPaneId(value: unknown): string | null {
	if (!value || typeof value !== "object") return null;
	if (Array.isArray(value)) {
		for (const item of value) {
			const found = findPaneId(item);
			if (found) return found;
		}
		return null;
	}
	const record = value as Record<string, unknown>;
	if (typeof record.pane_id === "string" && record.pane_id.length > 0) {
		return record.pane_id;
	}
	for (const child of Object.values(record)) {
		const found = findPaneId(child);
		if (found) return found;
	}
	return null;
}

export function firstPaneId(stdout: string): string | null {
	try {
		const parsed = JSON.parse(stdout) as { result?: unknown };
		return findPaneId(parsed.result);
	} catch {
		return null;
	}
}

export function agentIsLive(stdout: string, name: string): boolean {
	const agent = namedAgent(stdout, name);
	return agent !== null;
}

export interface NamedAgent {
	kind: string | null;
	name: string | null;
	paneId: string | null;
}

export function namedAgent(stdout: string, name: string): NamedAgent | null {
	try {
		const parsed = JSON.parse(stdout) as {
			result?: {
				agents?: Array<{ name?: string; agent?: string; pane_id?: string }>;
			};
		};
		const match = (parsed.result?.agents ?? []).find((agent) => agent.name === name);
		if (!match) return null;
		return {
			kind: match.agent ?? null,
			name: match.name ?? null,
			paneId: match.pane_id ?? null,
		};
	} catch {
		return null;
	}
}

/** A renamed Pi process is not a Rho agent. Kind and name both have to be rho. */
export function agentIsRho(stdout: string, name: string): boolean {
	const agent = namedAgent(stdout, name);
	return agent?.kind === "rho" && agent.name === name;
}

export function foregroundProcessName(stdout: string): string | null {
	try {
		const parsed = JSON.parse(stdout) as {
			result?: {
				process_info?: { foreground_processes?: Array<{ name?: string }> };
			};
		};
		const name = parsed.result?.process_info?.foreground_processes?.[0]?.name;
		return typeof name === "string" && name.length > 0 ? name : null;
	} catch {
		return null;
	}
}

export function isInteractiveShell(name: string | null): boolean {
	if (!name) return false;
	const base = name.replace(/^-/, "");
	return base === "bash" || base === "zsh" || base === "sh" || base === "fish" || base === "dash";
}
