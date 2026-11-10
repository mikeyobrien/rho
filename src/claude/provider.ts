// The "claude-code" provider: Claude on the person's plan. pi-ai's Anthropic adapter turns the
// conversation into Anthropic's format and parses the response; the request itself is made by
// the Claude Code CLI (relay.ts), which holds the login. This file reads no credentials.
import { spawn } from "node:child_process";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { createProvider } from "@earendil-works/pi-ai/models";
import { ANTHROPIC_MODELS } from "@earendil-works/pi-ai/providers/anthropic.models";
import type { Model, ProviderStreams } from "@earendil-works/pi-ai";
import { cliCommand, relayFetch, type RelayOptions } from "./relay.ts";

export const CLAUDE_CODE = "claude-code";
const LOGIN_HINT = "Claude Code is not logged in. Run: claude auth login";

export interface ClaudeStatus {
	available: boolean;
	loggedIn: boolean;
	plan?: string;
	detail?: string;
}

/** What `claude auth status` says. It makes no model request. */
export function claudeStatus(options: RelayOptions = {}, signal?: AbortSignal): Promise<ClaudeStatus> {
	const env = { ...process.env, ...options.env } as Record<string, string>;
	const [command, ...lead] = cliCommand(options, env);
	return new Promise((resolve) => {
		let out = "";
		let child;
		try {
			child = spawn(command, [...lead, "auth", "status"], { env, stdio: ["ignore", "pipe", "ignore"], signal });
		} catch (error) {
			return resolve({ available: false, loggedIn: false, detail: `Could not run ${command}: ${(error as Error).message}` });
		}
		child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
		child.on("error", (error) => resolve({ available: false, loggedIn: false, detail: `Could not run ${command}: ${error.message}` }));
		child.on("close", () => {
			try {
				const status = JSON.parse(out) as { loggedIn?: boolean; subscriptionType?: string };
				resolve(status.loggedIn ? { available: true, loggedIn: true, plan: status.subscriptionType } : { available: true, loggedIn: false, detail: LOGIN_HINT });
			} catch {
				resolve({ available: true, loggedIn: false, detail: LOGIN_HINT });
			}
		});
	});
}

interface Discovered {
	value: string;
	resolvedModel?: string;
	displayName?: string;
	description?: string;
}
const withoutContext = (id: string): string => id.replace(/\[1m\]$/, "");
/** Model id -> the name Claude Code selects it by (which may add `[1m]` for the large context). */
const routes = new Map<string, string>();
export const routeFor = (id: string): string => routes.get(id) ?? id;

/** The models Claude Code offers this login, asked of the CLI itself. No model request is made. */
export function discoverModels(options: RelayOptions = {}, signal?: AbortSignal, timeoutMs = 20_000): Promise<Discovered[]> {
	const env = { ...process.env, ...options.env, DISABLE_AUTOUPDATER: "1", DISABLE_ERROR_REPORTING: "1" } as Record<string, string>;
	for (const name of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"]) delete env[name];
	const [command, ...lead] = cliCommand(options, env);
	const args = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--model", "default", "--tools", "", "--setting-sources", "", "--strict-mcp-config",
		"--disable-slash-commands", "--permission-mode", "dontAsk", "--no-session-persistence", "--mcp-config", '{"mcpServers":{}}'];
	return new Promise((done, fail) => {
		const child = spawn(command, [...lead, ...args], { env, stdio: ["pipe", "pipe", "ignore"], signal });
		const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
		let out = "";
		const id = `rho-models-${Date.now()}`;
		child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
		child.on("error", (error) => (clearTimeout(timer), fail(new Error(`Could not run ${command}: ${error.message}`))));
		child.on("close", () => {
			clearTimeout(timer);
			for (const line of out.split("\n")) {
				try {
					const event = JSON.parse(line) as { type?: string; response?: { request_id?: string; subtype?: string; response?: { models?: Discovered[] } } };
					const models = event.type === "control_response" && event.response?.request_id === id && event.response.subtype === "success" ? event.response.response?.models : undefined;
					if (Array.isArray(models) && models.length > 0) return done(models.filter((model) => typeof model?.value === "string"));
				} catch {
					// not an event line
				}
			}
			fail(new Error("Claude Code returned no selectable models."));
		});
		child.stdin.write(`${JSON.stringify({ type: "control_request", request_id: id, request: { subtype: "initialize" } })}\n`);
		child.stdin.end(`${JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: "model-catalog-probe" }] }, shouldQuery: false })}\n`);
	});
}

/**
 * pi-ai's Anthropic catalog entry under this provider's name. Changes of system prompt, tools
 * or effort in the middle of a conversation are folded into the request's top level, because
 * the CLI takes one prompt, one tool list and one effort per turn.
 */
function planModel(model: Model<"anthropic-messages">, name?: string): Model<"anthropic-messages"> {
	return { ...model, ...(name ? { name } : {}), provider: CLAUDE_CODE, compat: { ...model.compat, supportsMidConvoEffort: false, supportsMidConvoSystemMessages: false, supportsMidConvoToolChanges: false } };
}

/** Before the CLI has been asked: every Claude model pi-ai knows. */
export function claudeCodeModels(): Model<"anthropic-messages">[] {
	return (Object.values(ANTHROPIC_MODELS) as Model<"anthropic-messages">[]).map((model) => planModel(model));
}

/** What the CLI offers, as catalog models; a model pi-ai does not know yet is left out. */
export function modelsFromDiscovery(found: Discovered[]): Model<"anthropic-messages">[] {
	const catalog = ANTHROPIC_MODELS as unknown as Record<string, Model<"anthropic-messages">>;
	const models = new Map<string, Model<"anthropic-messages">>();
	for (const info of found) {
		if (info.value === "default") continue; // an alias of one of the others
		const id = withoutContext(info.resolvedModel || info.value);
		const known = catalog[id];
		if (!known || models.has(id)) continue;
		routes.set(id, info.value);
		models.set(id, planModel(known)); // limits and prices are the catalog's, as pi lists them
	}
	return [...models.values()];
}

export function claudeCodeProvider(options: RelayOptions = {}) {
	let offered: Set<string> | undefined;
	const inner = anthropicMessagesApi();
	// Every request goes to the CLI; pi-ai's own retries are off, since a retry is a new CLI turn.
	const withRelay = <F extends (...args: any[]) => any>(stream: F): F =>
		((model: unknown, context: unknown, request?: { sessionId?: string; cacheRetention?: string }) =>
			stream({ ...(model as Model<"anthropic-messages">), id: routeFor((model as Model<"anthropic-messages">).id) }, context, { ...request, fetch: relayFetch(options, { sessionId: request?.cacheRetention === "none" ? undefined : request?.sessionId }), maxRetries: 0 })) as F;
	const api: ProviderStreams = { ...inner, stream: withRelay(inner.stream), streamSimple: withRelay(inner.streamSimple) };
	// The login is asked of the CLI, which costs a process. The answer is kept for half a minute:
	// rho asks which models can be used far more often than a login changes.
	let last: { at: number; status: Promise<ClaudeStatus> } | undefined;
	const status = (): Promise<ClaudeStatus> => {
		if (!last || Date.now() - last.at > 30_000) last = { at: Date.now(), status: claudeStatus(options) };
		return last.status;
	};
	return createProvider({
		id: CLAUDE_CODE,
		name: "Claude (through Claude Code)",
		baseUrl: "https://api.anthropic.com",
		auth: {
			apiKey: {
				name: "Claude Code login",
				async check() {
					const now = await status();
					return now.available && now.loggedIn ? { type: "oauth", source: `Claude Code ${now.plan ?? "login"}` } : undefined;
				},
				// A placeholder: the CLI makes the request with its own login.
				async resolve() {
					return { auth: { apiKey: "claude-code-login" }, source: "Claude Code CLI" };
				},
			},
		},
		models: claudeCodeModels(),
		async fetchModels({ signal }) {
			const models = modelsFromDiscovery(await discoverModels(options, signal));
			offered = new Set(models.map((model) => model.id));
			return models;
		},
		// Once the CLI has been asked, only what it offers this login is listed.
		filterModels: (models) => (offered ? models.filter((model) => offered!.has(model.id)) : models),
		api,
	});
}
