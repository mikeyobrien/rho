import { THINKING_LEVELS_BASE } from "./rendering-and-usage.js";

function supportsXhighThinking(model) {
	if (!model || typeof model !== "object") {
		return false;
	}
	const modelId = String(model.modelId ?? model.id ?? model.name ?? "")
		.trim()
		.toLowerCase();
	if (!modelId) {
		return false;
	}
	return (
		/^gpt-5\.1-codex-max(?:-|$)/.test(modelId) ||
		/^gpt-5\.2(?:-codex)?(?:-|$)/.test(modelId) ||
		/^gpt-5\.3(?:-codex)?(?:-|$)/.test(modelId)
	);
}

function resolveModelCapabilities(model, availableModels) {
	if (!model || typeof model !== "object") {
		return null;
	}
	const provider = String(model.provider ?? "").toLowerCase();
	const modelId = String(
		model.modelId ?? model.id ?? model.name ?? "",
	).toLowerCase();
	if (!modelId || !Array.isArray(availableModels)) {
		return model;
	}
	return (
		availableModels.find((candidate) => {
			const candidateProvider = String(candidate.provider ?? "").toLowerCase();
			const candidateId = String(
				candidate.modelId ?? candidate.id ?? candidate.name ?? "",
			).toLowerCase();
			if (!candidateId) {
				return false;
			}
			if (provider) {
				return candidateProvider === provider && candidateId === modelId;
			}
			return candidateId === modelId;
		}) ?? model
	);
}

function thinkingLevelsForModel(model, availableModels) {
	const capabilities = resolveModelCapabilities(model, availableModels);
	if (!capabilities || !capabilities.reasoning) {
		return ["off"];
	}
	const levels = [...THINKING_LEVELS_BASE];
	if (supportsXhighThinking(capabilities)) {
		levels.push("xhigh");
	}
	return levels;
}

// Toast notification levels
const TOAST_LEVELS = {
	info: { color: "var(--cyan)", icon: "ℹ" },
	success: { color: "var(--green)", icon: "✓" },
	warning: { color: "var(--yellow)", icon: "⚠" },
	error: { color: "var(--red)", icon: "✕" },
};

// Default toast duration
const TOAST_DEFAULT_DURATION = 5000;

export {
	supportsXhighThinking,
	resolveModelCapabilities,
	thinkingLevelsForModel,
	TOAST_LEVELS,
	TOAST_DEFAULT_DURATION,
};
