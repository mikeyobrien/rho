/**
 * Pure launch planning for Rho's isolated Pi process.
 */
import { type RhoPaths, buildPiChildEnv, piLaunchArgs } from "./rho-paths.ts";

export interface DaemonLaunchPlan {
	ok: boolean;
	error?: string;
	cwd: string;
	env: NodeJS.ProcessEnv;
	tmuxCommands: string[][];
	piCommand: string;
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function planDaemonLaunch(input: {
	piBin: string | null;
	paths: RhoPaths;
	tmuxBaseArgs: string[];
	sessionName: string;
	baseEnv?: NodeJS.ProcessEnv;
}): DaemonLaunchPlan {
	const env = buildPiChildEnv(input.paths, input.baseEnv ?? {});
	if (!input.piBin) {
		return {
			ok: false,
			error:
				"pi is not installed. Install the Pi coding agent before starting Rho.",
			cwd: input.paths.workspaceDir,
			env,
			tmuxCommands: [],
			piCommand: "",
		};
	}

	const piArgs = piLaunchArgs(input.paths, ["-c"]).map(shellQuote).join(" ");
	const piCommand = [
		`PI_CODING_AGENT_DIR=${shellQuote(input.paths.piAgentDir)}`,
		`PI_CODING_AGENT_SESSION_DIR=${shellQuote(input.paths.sessionDir)}`,
		shellQuote(input.piBin),
		piArgs,
	].join(" ");
	const set = (key: string, value: string) => [
		...input.tmuxBaseArgs,
		"set-environment",
		"-g",
		key,
		value,
	];
	return {
		ok: true,
		cwd: input.paths.workspaceDir,
		env,
		piCommand,
		tmuxCommands: [
			[
				...input.tmuxBaseArgs,
				"new-session",
				"-d",
				"-s",
				input.sessionName,
				"-c",
				input.paths.workspaceDir,
				piCommand,
			],
			set("PI_CODING_AGENT_DIR", input.paths.piAgentDir),
			set("PI_CODING_AGENT_SESSION_DIR", input.paths.sessionDir),
		],
	};
}

export function skillProviderScope(
	provider: string,
	paths: RhoPaths,
): {
	ok: boolean;
	error?: string;
	workdir?: string;
} {
	if (provider === "vercel") {
		return {
			ok: false,
			error:
				"The Vercel skills provider writes a shared store and cannot be scoped to Rho. Use --provider clawhub, or copy skills into the Rho agent directory.",
		};
	}
	if (provider === "clawhub") {
		return { ok: true, workdir: paths.piAgentDir };
	}
	return { ok: false, error: `Unsupported skill provider: ${provider}` };
}
