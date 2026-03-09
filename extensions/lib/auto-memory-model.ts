import {
	DEFAULT_INIT_TOML_PATH,
	readConfiguredMemorySettings,
} from "./memory-settings.ts";

export interface AutoMemoryModelLike {
	provider: string;
	id: string;
	cost: {
		output: number;
	};
}

export interface AutoMemoryModelRegistryLike<
	TModel extends AutoMemoryModelLike,
> {
	find(provider: string, id: string): TModel | undefined;
	getAll(): TModel[];
	getApiKey(model: TModel): Promise<string | null | undefined>;
}

export type AutoMemoryModelSource = "configured" | "auto" | "session-fallback";

export interface AutoMemoryModelResolution<TModel extends AutoMemoryModelLike> {
	model: TModel;
	apiKey: string;
	source: AutoMemoryModelSource;
	requestedModel: string | null;
	warning?: string;
}

function normalizeConfiguredModel(
	raw: unknown,
):
	| { kind: "unset"; requestedModel: null }
	| { kind: "auto"; requestedModel: "auto" }
	| { kind: "configured"; requestedModel: string; provider: string; id: string }
	| { kind: "invalid"; requestedModel: string; warning: string } {
	if (typeof raw !== "string") {
		return { kind: "unset", requestedModel: null };
	}

	const trimmed = raw.trim();
	if (!trimmed) {
		return { kind: "unset", requestedModel: null };
	}

	if (trimmed === "auto") {
		return { kind: "auto", requestedModel: "auto" };
	}

	const parts = trimmed.split("/");
	if (parts.length !== 2 || !parts[0] || !parts[1]) {
		return {
			kind: "invalid",
			requestedModel: trimmed,
			warning: `Invalid auto_memory_model '${trimmed}'. Expected 'auto' or 'provider/model-id'.`,
		};
	}

	return {
		kind: "configured",
		requestedModel: trimmed,
		provider: parts[0],
		id: parts[1],
	};
}

export function readInitAutoMemoryModelSetting(
	initPath: string = DEFAULT_INIT_TOML_PATH,
): string | undefined {
	return readConfiguredMemorySettings(initPath).autoMemoryModel;
}

export async function resolveAutoMemoryModel<
	TModel extends AutoMemoryModelLike,
>(options: {
	configuredModel?: unknown;
	currentModel?: TModel | null;
	registry: AutoMemoryModelRegistryLike<TModel>;
}): Promise<AutoMemoryModelResolution<TModel> | null> {
	const configured = normalizeConfiguredModel(options.configuredModel);
	let warning: string | undefined;

	if (configured.kind === "invalid") {
		warning = configured.warning;
	} else if (configured.kind === "configured") {
		const model = options.registry.find(configured.provider, configured.id);
		if (!model) {
			warning = `Configured auto_memory_model '${configured.requestedModel}' was not found in the model registry.`;
		} else {
			const apiKey = await options.registry.getApiKey(model);
			if (apiKey) {
				return {
					model,
					apiKey,
					source: "configured",
					requestedModel: configured.requestedModel,
				};
			}
			warning = `Configured auto_memory_model '${configured.requestedModel}' has no available API key.`;
		}
	}

	const currentModel = options.currentModel;
	if (!currentModel) {
		return null;
	}

	const currentApiKey = await options.registry.getApiKey(currentModel);
	if (!currentApiKey) {
		return null;
	}

	const sameProvider = options.registry
		.getAll()
		.filter((model) => model.provider === currentModel.provider)
		.sort((a, b) => a.cost.output - b.cost.output);

	for (const candidate of sameProvider) {
		const apiKey = await options.registry.getApiKey(candidate);
		if (!apiKey) {
			continue;
		}
		return {
			model: candidate,
			apiKey,
			source: "auto",
			requestedModel:
				configured.kind === "auto" ? "auto" : configured.requestedModel,
			warning,
		};
	}

	return {
		model: currentModel,
		apiKey: currentApiKey,
		source: "session-fallback",
		requestedModel:
			configured.kind === "auto" ? "auto" : configured.requestedModel,
		warning,
	};
}
