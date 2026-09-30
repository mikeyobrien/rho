/**
 * Ask Jev whether a queued job should start, given its prompt and the
 * load already running. Memory below the veto is not asked.
 */

import {
	type AdmissionChoice,
	type AdmissionState,
	interpretAdmission,
	jevRoute,
	readJevEnabled,
} from "../extensions/lib/jobs.ts";

const ENDPOINT =
	process.env.SYSTEMONE_ENDPOINT?.trim() ||
	"https://api.typesafe.ai/v1/systemone";
const MODEL = "jev-1.13.0";

export function jevApiKey(
	env: NodeJS.ProcessEnv = process.env,
	apiKeyEnv = "TYPESAFE_API_KEY",
): string | null {
	const named = apiKeyEnv.trim();
	const key =
		(named ? env[named]?.trim() : "") ||
		env.SYSTEMONE_API_KEY?.trim() ||
		env.TYPESAFE_API_KEY?.trim() ||
		"";
	return key || null;
}

export function resolveJevRoute(input: {
	enabled?: unknown;
	apiKeyEnv?: unknown;
	env?: NodeJS.ProcessEnv;
}): { route: boolean; enabled: boolean; apiKeyEnv: string } {
	const enabled = readJevEnabled(input.enabled);
	const apiKeyEnv =
		typeof input.apiKeyEnv === "string" && input.apiKeyEnv.trim()
			? input.apiKeyEnv.trim()
			: "TYPESAFE_API_KEY";
	return {
		enabled,
		apiKeyEnv,
		route: jevRoute({
			enabled,
			hasApiKey: jevApiKey(input.env, apiKeyEnv) !== null,
		}),
	};
}

export function admissionRequest(state: AdmissionState): {
	model: string;
	state: AdmissionState;
	questions: {
		admit: {
			type: "choice";
			instructions: string;
			criteria: { start: string; wait: string };
		};
	};
} {
	return {
		model: MODEL,
		state,
		questions: {
			admit: {
				type: "choice",
				instructions:
					"Decide whether to start this job now. The prompt is the only description of the work. Use the running jobs, load average, CPU count, and free memory. Wait if the prompt looks heavy and similar work is already running, if load is already at the CPU count, or if free memory is tight for another process. Start if the prompt looks able to run alongside the current load.",
				criteria: {
					start: "Start this job now.",
					wait: "Leave this job queued.",
				},
			},
		},
	};
}

export async function askJev(
	state: AdmissionState,
	env: NodeJS.ProcessEnv = process.env,
	fetchImpl: typeof fetch = fetch,
	settings: { enabled?: unknown; apiKeyEnv?: unknown } = {},
): Promise<AdmissionChoice | "unavailable"> {
	const route = resolveJevRoute({ ...settings, env });
	if (!route.route) return "unavailable";
	const key = jevApiKey(env, route.apiKeyEnv);
	if (!key) return "unavailable";
	let response: Response;
	try {
		response = await fetchImpl(ENDPOINT, {
			method: "POST",
			headers: {
				authorization: `Bearer ${key}`,
				"content-type": "application/json",
			},
			body: JSON.stringify(admissionRequest(state)),
			redirect: "error",
		});
	} catch {
		return "unavailable";
	}
	if (!response.ok) return "unavailable";
	let body: unknown;
	try {
		body = await response.json();
	} catch {
		return "unavailable";
	}
	const answers = (body as { answers?: { admit?: unknown } } | null)?.answers;
	const admit = answers?.admit as
		| { type?: string; choice?: string; confidence?: number }
		| undefined;
	if (!admit || admit.type !== "choice") return "unavailable";
	if (admit.choice !== "start" && admit.choice !== "wait") return "unavailable";
	if (
		typeof admit.confidence !== "number" ||
		admit.confidence < 0 ||
		admit.confidence > 1
	) {
		return "unavailable";
	}
	return interpretAdmission(admit);
}
