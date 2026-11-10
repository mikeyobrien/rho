// Which models rho can use, and what is missing when it can use none.
//
// The providers are pi-ai's own: Anthropic, OpenAI, Google, OpenRouter and the rest, each used
// with the person's API key. A key comes from `rho key <provider>` (stored in the data directory,
// readable by the owner only) or from the provider's usual environment variable. A server that
// speaks the OpenAI chat API, such as a local model, is added in the config.
//
// The Claude-plan provider runs the person's Claude Code login. It is off until the config says
// `"claudePlan": true`, because what a plan allows another program to do is Anthropic's to change.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { createModels, createProvider, type MutableModels, type Provider } from "@earendil-works/pi-ai/models";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { claudeCodeProvider, CLAUDE_CODE } from "./claude/provider.ts";
import type { RhoConfig } from "./core.ts";

type Credential = { type: "api_key"; key?: string; env?: Record<string, string> };
type Env = Record<string, string | undefined>;

/** The first of these that has a key is the model of a new conversation. */
export const PREFERRED = ["anthropic/claude-sonnet-5-5", "openai/gpt-5.5", "google/gemini-3.1-pro-preview", "openrouter/anthropic/claude-sonnet-5.5"] as const;
/** The providers the first-run text names, with where a key comes from. */
export const SUGGESTED = [
	{ id: "anthropic", name: "Anthropic", env: "ANTHROPIC_API_KEY" },
	{ id: "openai", name: "OpenAI", env: "OPENAI_API_KEY" },
	{ id: "google", name: "Google Gemini", env: "GEMINI_API_KEY" },
	{ id: "openrouter", name: "OpenRouter", env: "OPENROUTER_API_KEY" },
] as const;
export const CLAUDE_PLAN_WARNING =
	"Claude plan: rho is using your Claude Code login. This is not an API key. Anthropic decides what a plan may be used for and has changed it before: " +
	"requests can be refused, or charged to usage credits instead of your plan. Rho stops a turn rather than spend credits. To use an API key instead, remove \"claudePlan\" from config.json and run: rho key anthropic";

/** A server that speaks the OpenAI chat API, named in the config. */
export interface CustomProvider {
	id: string;
	name?: string;
	baseUrl: string;
	/** The environment variable that holds its key. A local server usually needs none. */
	apiKeyEnv?: string;
	models: (string | { id: string; name?: string; contextWindow?: number; maxTokens?: number; reasoning?: boolean; images?: boolean })[];
}

/** API keys in `<dir>/keys.json`, mode 0600. Read on every use, so a key added while rho runs is used at once. */
export function keyStore(dir: string) {
	const path = join(dir, "keys.json");
	const all = (): Record<string, Credential> => {
		try {
			const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
			return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, Credential>) : {};
		} catch {
			return {}; // no file, or one that does not parse: no stored keys
		}
	};
	const save = (value: Record<string, Credential>): void => {
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		writeFileSync(`${path}.tmp`, `${JSON.stringify(value, null, "\t")}\n`, { mode: 0o600 });
		chmodSync(`${path}.tmp`, 0o600);
		renameSync(`${path}.tmp`, path);
	};
	let chain: Promise<unknown> = Promise.resolve();
	const serial = <T>(work: () => Promise<T>): Promise<T> => {
		const next = chain.then(work, work);
		chain = next.catch(() => undefined);
		return next;
	};
	return {
		path,
		read: async (providerId: string) => all()[providerId],
		list: async () => Object.entries(all()).map(([providerId, credential]) => ({ providerId, type: credential.type })),
		modify: (providerId: string, change: (current: Credential | undefined) => Promise<Credential | undefined>) =>
			serial(async () => {
				const now = all();
				const next = await change(now[providerId]);
				if (next === undefined) return now[providerId];
				save({ ...now, [providerId]: next });
				return next;
			}),
		delete: (providerId: string) =>
			serial(async () => {
				const now = all();
				if (!(providerId in now)) return;
				delete now[providerId];
				save(now);
			}),
		has: (providerId: string): boolean => existsSync(path) && providerId in all(),
	};
}
export type KeyStore = ReturnType<typeof keyStore>;

function customProvider(spec: CustomProvider, env: Env): Provider {
	const id = String(spec.id ?? "");
	if (!/^[a-z0-9][a-z0-9_-]{0,39}$/.test(id)) throw new Error(`a provider id is lower-case letters, digits, - and _ (got ${JSON.stringify(spec.id)})`);
	if (typeof spec.baseUrl !== "string" || !/^https?:\/\//.test(spec.baseUrl)) throw new Error(`provider ${id}: baseUrl is an http or https address`);
	if (!Array.isArray(spec.models) || spec.models.length === 0) throw new Error(`provider ${id}: models lists at least one model id`);
	const name = spec.name ?? id;
	return createProvider({
		id,
		name,
		baseUrl: spec.baseUrl,
		auth: {
			apiKey: {
				name: `${name} API key`,
				// A stored key, then the named variable; a server that asks for none is given a placeholder.
				resolve: async ({ credential }) => {
					const key = credential?.key ?? (spec.apiKeyEnv ? env[spec.apiKeyEnv] : undefined);
					if (spec.apiKeyEnv && !key) return undefined;
					return { auth: { apiKey: key ?? "none" }, source: credential?.key ? "stored credential" : (spec.apiKeyEnv ?? "no key needed") };
				},
			},
		},
		models: spec.models.map((model) => {
			const given = typeof model === "string" ? { id: model } : model;
			if (typeof given.id !== "string" || given.id === "") throw new Error(`provider ${id}: every model has an id`);
			return {
				id: given.id,
				name: given.name ?? given.id,
				api: "openai-completions" as const,
				provider: id,
				baseUrl: spec.baseUrl,
				input: given.images ? ["text" as const, "image" as const] : ["text" as const],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				reasoning: given.reasoning ?? false,
				contextWindow: given.contextWindow ?? 32_768,
				maxTokens: given.maxTokens ?? 4_096,
			};
		}),
		api: openAICompletionsApi(),
	});
}

export interface ModelsOptions {
	dir: string;
	config: RhoConfig;
	env?: Env;
	log?: (line: string) => void;
}
/** The models of this rho: pi-ai's providers on the person's keys, their own servers, and Claude on their plan when they chose it. */
export function openModels(options: ModelsOptions): { models: MutableModels; keys: KeyStore; claudePlan: boolean } {
	const env = options.env ?? process.env;
	const log = options.log ?? (() => {});
	const keys = keyStore(options.dir);
	const models = createModels({ credentials: keys as never, authContext: { env: async (name) => env[name] || undefined, fileExists: async (path) => existsSync(path.replace(/^~(?=\/|$)/, env.HOME ?? "~")) } });
	for (const provider of builtinProviders()) models.setProvider(provider);
	const custom = options.config.providers;
	if (custom !== undefined && !Array.isArray(custom)) log("config: providers is a list and was ignored.");
	for (const spec of Array.isArray(custom) ? (custom as CustomProvider[]) : []) {
		try {
			if (models.getProvider(spec?.id) || spec?.id === CLAUDE_CODE) throw new Error(`provider ${spec.id}: that id is taken by a built-in provider`);
			models.setProvider(customProvider(spec, env));
		} catch (error) {
			log(`config: ${(error as Error).message}; it was left out.`); // one bad entry does not stop rho
		}
	}
	const claudePlan = options.config.claudePlan === true;
	if (claudePlan) {
		models.setProvider(claudeCodeProvider(env.RHO_CLAUDE ? { command: env.RHO_CLAUDE } : {}));
		log(CLAUDE_PLAN_WARNING);
	}
	return { models, keys, claudePlan };
}

/**
 * The environment variables that can hold a provider's key or token, for every provider rho
 * knows. The daemon takes these out of its own environment once it has read them, so the `bash`
 * tool, which runs with the daemon's environment, cannot print them.
 *
 * pi-ai does not publish the list, so it is learned by asking: each provider is asked for its
 * login against an empty environment, and every name it looks up is noted.
 */
export async function keyVariables(config: RhoConfig): Promise<string[]> {
	const asked = new Set<string>();
	const probe = createModels({ authContext: { env: async (name) => void asked.add(name), fileExists: async () => false } });
	for (const provider of builtinProviders()) probe.setProvider(provider);
	await Promise.all(probe.getProviders().map((provider) => probe.checkAuth(provider.id).catch(() => undefined)));
	// Only secrets: a region, a profile or an account id stays, because the person's own commands may need it.
	// Not the AWS variables: they are the person's cloud login, which their own commands use too.
	const names = new Set([...asked].filter((name) => /KEY|TOKEN|SECRET/.test(name) && !/_FILE$/.test(name) && !name.startsWith("AWS_")));
	for (const spec of Array.isArray(config.providers) ? (config.providers as CustomProvider[]) : []) if (typeof spec?.apiKeyEnv === "string") names.add(spec.apiKeyEnv);
	return [...names].sort();
}

const idOf = (model: { provider: string; id: string }): string => `${model.provider}/${model.id}`;
/**
 * The model of a new conversation: the configured one; else the first preferred model whose
 * provider has a key; else Claude on the plan when that was chosen; else any model that can be
 * used. Undefined when none can.
 */
export async function chooseModel(models: MutableModels, config: RhoConfig): Promise<string | undefined> {
	if (typeof config.model === "string" && config.model !== "") return config.model;
	const available = (await models.getAvailable()).map(idOf);
	const preferred = PREFERRED.find((id) => available.includes(id));
	if (preferred) return preferred;
	if (config.claudePlan === true) {
		const plan = available.filter((id) => id.startsWith(`${CLAUDE_CODE}/`));
		return plan.find((id) => /opus/.test(id)) ?? plan[0] ?? `${CLAUDE_CODE}/claude-opus-5-5`;
	}
	// A key for a provider that is not in the preferred list, or a server of the person's own.
	for (const provider of [...(Array.isArray(config.providers) ? (config.providers as CustomProvider[]).map((spec) => spec?.id) : []), ...new Set(available.map((id) => id.slice(0, id.indexOf("/"))))]) {
		const first = available.find((id) => id.startsWith(`${provider}/`));
		if (first) return first;
	}
	return undefined;
}

export interface Setup {
	/** True when the model can be used now. */
	ready: boolean;
	model?: string;
	/** What to do, when not ready. */
	note?: string;
}
/** Whether `model` can be used, and what the person does when it cannot. */
export async function setupOf(models: MutableModels, model: string | undefined): Promise<Setup> {
	const available = (await models.getAvailable()).map(idOf);
	if (model !== undefined && available.includes(model)) return { ready: true, model };
	const provider = model?.slice(0, model.indexOf("/"));
	const known = provider !== undefined && models.getProvider(provider) !== undefined;
	const keyed = known && (await models.checkAuth(provider!).catch(() => undefined)) !== undefined;
	let note: string;
	if (model === undefined || !known || !keyed) {
		const named = SUGGESTED.find((item) => item.id === provider);
		const how = named ? `rho key ${named.id}` : `rho key <provider>   (${SUGGESTED.map((item) => item.id).join(", ")}, or see: rho key)`;
		note = provider === CLAUDE_CODE ? `This conversation uses Claude on your plan, which is off. Turn it on with "claudePlan": true in config.json, or add an API key and pick another model: rho key anthropic`
			: model !== undefined && !known ? `No provider is called ${provider} (the model is ${model}). Add an API key with: rho key <provider>   (${SUGGESTED.map((item) => item.id).join(", ")})`
			: `Rho has no model to use yet. Add an API key with: ${how}`;
	} else note = `The model ${model} is not one ${provider} offers. Pick another in the page's menu, or set "model" in config.json.`;
	return { ready: false, ...(model ? { model } : {}), note };
}
