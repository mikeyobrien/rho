// The "claude-code" provider: Claude on the person's plan. Requests are built and parsed by
// pi-ai's own Anthropic adapter, and sent by the relay (relay.ts) through the Claude Code CLI,
// which holds the login. This file reads no credentials.
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

/** The plan's models: pi-ai's Anthropic catalog, under this provider's name. */
export function claudeCodeModels(): Model<"anthropic-messages">[] {
	return (Object.values(ANTHROPIC_MODELS) as Model<"anthropic-messages">[]).map((model) => ({ ...model, provider: CLAUDE_CODE }));
}

export function claudeCodeProvider(options: RelayOptions = {}) {
	const send = relayFetch(options);
	const inner = anthropicMessagesApi();
	// Every request goes through the relay; pi-ai's own retries are off, since a retry is a new CLI turn.
	const withRelay = <F extends (...args: any[]) => any>(stream: F): F => ((model: unknown, context: unknown, request?: object) => stream(model, context, { ...request, fetch: send, maxRetries: 0 })) as F;
	const api: ProviderStreams = { ...inner, stream: withRelay(inner.stream), streamSimple: withRelay(inner.streamSimple) };
	return createProvider({
		id: CLAUDE_CODE,
		name: "Claude (through Claude Code)",
		baseUrl: "https://api.anthropic.com",
		auth: {
			apiKey: {
				name: "Claude Code login",
				async check({ signal }) {
					const status = await claudeStatus(options, signal);
					return status.available && status.loggedIn ? { type: "oauth", source: `Claude Code ${status.plan ?? "login"}` } : undefined;
				},
				// A placeholder: the relay replaces the request's auth with the CLI's own.
				async resolve() {
					return { auth: { apiKey: "claude-code-login" }, source: "Claude Code CLI" };
				},
			},
		},
		models: claudeCodeModels(),
		api,
	});
}
