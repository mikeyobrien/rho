import * as primitives from "./constants-and-primitives.js";
import * as modelThinking from "./model-thinking-and-toast.js";
import * as renderingUsage from "./rendering-and-usage.js";
import * as toolSemantics from "./tool-semantics.js";

const {
	slashContract,
	toFiniteNumber,
	parseUsageTotals,
	normalizeThinkingLevel,
} = { ...primitives, ...toolSemantics, ...renderingUsage, ...modelThinking };

export const rhoChatModelAndExtensionMethods = {
	accumulateUsageFromMessage(message) {
		if (!message || message.role !== "assistant") {
			return;
		}

		const messageId = String(message.id ?? "");
		if (messageId && this.usageAccountedMessageIds.has(messageId)) {
			return;
		}

		const totals = parseUsageTotals(message.usage);
		const cost = totals.cost ?? 0;
		const fallbackTotal =
			totals.input + totals.output + totals.cacheRead + totals.cacheWrite;
		const totalTokens = totals.total || fallbackTotal;
		const hasUsage =
			totalTokens > 0 ||
			totals.input > 0 ||
			totals.output > 0 ||
			totals.cacheRead > 0 ||
			totals.cacheWrite > 0 ||
			cost > 0;
		if (!hasUsage) {
			return;
		}

		const currentTokens = toFiniteNumber(this.sessionStats?.tokens) ?? 0;
		const currentCost = toFiniteNumber(this.sessionStats?.cost) ?? 0;
		const currentInput = toFiniteNumber(this.sessionStats?.inputTokens) ?? 0;
		const currentOutput = toFiniteNumber(this.sessionStats?.outputTokens) ?? 0;
		const currentCacheRead = toFiniteNumber(this.sessionStats?.cacheRead) ?? 0;
		const currentCacheWrite =
			toFiniteNumber(this.sessionStats?.cacheWrite) ?? 0;

		this.sessionStats = {
			tokens: currentTokens + totalTokens,
			cost: currentCost + cost,
			inputTokens: currentInput + totals.input,
			outputTokens: currentOutput + totals.output,
			cacheRead: currentCacheRead + totals.cacheRead,
			cacheWrite: currentCacheWrite + totals.cacheWrite,
		};
		if (messageId) {
			this.usageAccountedMessageIds.add(messageId);
		}
		this.updateFooter();
	},

	modelDropdownLabel(model) {
		if (!model) {
			return "";
		}
		const provider = model.provider ?? "";
		const modelId = model.modelId ?? model.id ?? model.name ?? "";
		if (provider && modelId) {
			return `${provider}/${modelId}`;
		}
		return modelId || provider || "unknown";
	},

	isCurrentModel(model) {
		if (!this.currentModel || !model) {
			return false;
		}
		const currentId =
			this.currentModel.modelId ?? this.currentModel.id ?? this.currentModel;
		const checkId = model.modelId ?? model.id ?? model;
		const currentProvider = this.currentModel.provider ?? "";
		const checkProvider = model.provider ?? "";
		return currentId === checkId && currentProvider === checkProvider;
	},

	setModel(model) {
		if (!this.activeRpcSessionId || this.isStreaming) {
			return;
		}
		this.pendingModelChange = model;
		this.sendWs({
			type: "rpc_command",
			sessionId: this.activeRpcSessionId,
			command: {
				type: "set_model",
				provider: model.provider,
				modelId: model.modelId ?? model.id,
			},
		});
		// Optimistically update
		this.currentModel = model;
		this.syncThinkingLevels();
		this.updateFooter();
	},

	setThinkingLevel(level) {
		if (!this.activeRpcSessionId || this.isStreaming) {
			return;
		}
		const normalizedLevel = normalizeThinkingLevel(level);
		if (!this.thinkingLevels.includes(normalizedLevel)) {
			return;
		}
		this.sendWs({
			type: "rpc_command",
			sessionId: this.activeRpcSessionId,
			command: {
				type: "set_thinking_level",
				level: normalizedLevel,
			},
		});
		this.currentThinkingLevel = normalizedLevel;
		this.updateFooter();
	},

	cycleThinkingLevel() {
		if (!this.activeRpcSessionId || this.isStreaming) {
			return;
		}
		const levels = this.thinkingLevels.length ? this.thinkingLevels : ["off"];
		const current = normalizeThinkingLevel(this.currentThinkingLevel);
		const currentIndex = levels.indexOf(current);
		const nextIndex = (currentIndex + 1) % levels.length;
		this.setThinkingLevel(levels[nextIndex]);
	},

	abort() {
		if (!this.activeRpcSessionId || !this.isStreaming) {
			return;
		}
		this.sendWs({
			type: "rpc_command",
			sessionId: this.activeRpcSessionId,
			command: { type: "abort" },
		});
		// Optimistically reset streaming state so UI returns to "Send" mode
		// immediately. The agent_end event will arrive later to confirm.
		this.isStreaming = false;
		this.isSendingPrompt = false;
		this.promptQueue = [];
		this.updateFooter();
	},

	// ─── Queue management ───

	removeQueueItem(id) {
		this.promptQueue = this.promptQueue.filter((item) => item.id !== id);
	},

	updateQueueItemText(id, text) {
		const item = this.promptQueue.find((item) => item.id === id);
		if (item) item.text = text;
	},

	addQueueItemImage(id, event) {
		const item = this.promptQueue.find((item) => item.id === id);
		if (!item) return;
		const files = event.target?.files;
		if (!files) return;
		for (const file of files) {
			if (!file.type.startsWith("image/")) continue;
			const reader = new FileReader();
			reader.onload = (e) => {
				const dataUrl = e.target.result;
				const base64 = dataUrl.split(",")[1];
				item.images.push({
					data: base64,
					mimeType: file.type,
					dataUrl,
				});
			};
			reader.readAsDataURL(file);
		}
		// Reset file input so same file can be re-selected
		event.target.value = "";
	},

	removeQueueItemImage(id, imageIndex) {
		const item = this.promptQueue.find((item) => item.id === id);
		if (item) item.images.splice(imageIndex, 1);
	},

	mergeQueueItemDown(idx) {
		if (idx >= this.promptQueue.length - 1) return;
		const current = this.promptQueue[idx];
		const next = this.promptQueue[idx + 1];
		current.text = [current.text, next.text].filter(Boolean).join("\n");
		current.images = [...current.images, ...next.images];
		this.promptQueue.splice(idx + 1, 1);
	},

	handlePromptSubmit() {
		const message = this.promptText.trim();
		if (!message && this.pendingImages.length === 0) {
			return;
		}

		const slashClassification = this.classifySlashPrompt(message);
		if (slashClassification.isSlash) {
			if (!this.slashCommandsLoaded) {
				this.requestSlashCommands(true);
				this.error = "Loading slash commands from RPC. Try again in a moment.";
				return;
			}

			if (slashClassification.kind !== "supported") {
				this.error =
					slashContract.formatUnsupportedMessage(slashClassification);
				return;
			}

			this.sendSlashPrompt(message, slashClassification);
			return;
		}

		if (this.isStreaming) {
			// During streaming, queue the message with any pending images
			const text = this.promptText.trim();
			const images =
				this.pendingImages.length > 0 ? [...this.pendingImages] : [];
			this.promptQueue.push({
				id: `q-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
				text,
				images,
			});
			this.promptText = "";
			this.pendingImages = [];
			this.focusComposer();
		} else {
			// Normal prompt submission
			this.sendPrompt();
		}
	},

	updateFooter() {
		const tokensEl = document.querySelector(".footer .footer-tokens");
		const costEl = document.querySelector(".footer .footer-cost");
		const statusEl = document.querySelector(".footer .footer-status");
		const extStatusEl = document.querySelector(".footer .footer-ext-status");

		if (tokensEl) {
			const tokens = toFiniteNumber(this.sessionStats?.tokens) ?? 0;
			tokensEl.textContent = `tokens: ${tokens.toLocaleString()}`;
		}
		if (costEl) {
			const cost = toFiniteNumber(this.sessionStats?.cost) ?? 0;
			costEl.textContent = `cost: $${cost.toFixed(4)}`;
		}
		if (statusEl) {
			statusEl.textContent = `status: ${this.isStreaming ? "streaming" : "idle"}`;
			statusEl.classList.toggle("streaming", this.isStreaming);
		}
		if (extStatusEl) {
			extStatusEl.textContent = this.extensionStatus || "";
			extStatusEl.style.display = this.extensionStatus ? "inline" : "none";
		}
	},

	// Helper getters for template
	canSwitchModel() {
		return this.isForkActive() && !this.isStreaming;
	},

	canChangeThinking() {
		return this.isForkActive() && !this.isStreaming;
	},

	canAbort() {
		return this.isForkActive() && this.isStreaming;
	},

	thinkingLevelLabel() {
		return this.currentThinkingLevel || "medium";
	},

	inputPlaceholder() {
		if (!this.isInteractiveSession()) {
			return "Fork a session to start chatting...";
		}
		if (!this.isForkActive()) {
			return "Type a prompt to start this session...";
		}
		if (this.isStreaming) {
			return "Streaming… send to queue";
		}
		return "Type a prompt...";
	},

	submitButtonLabel() {
		if (this.isStreaming) {
			return "Queue";
		}
		return "Send";
	},

	// Extension UI methods

	handleExtensionUIRequest(event) {
		const request = event.request ?? event;
		const method = request.method ?? request.type ?? "";
		const id = request.id ?? `ext-${Date.now()}`;
		const timeout = request.timeout ?? request.timeoutMs ?? 0;

		if (method === "select") {
			this.showSelectDialog(id, request, timeout);
			return;
		}

		if (method === "confirm") {
			this.showConfirmDialog(id, request, timeout);
			return;
		}

		if (method === "input") {
			this.showInputDialog(id, request, timeout);
			return;
		}

		if (method === "editor") {
			this.showEditorDialog(id, request, timeout);
			return;
		}
	},

	showSelectDialog(id, request, timeout) {
		const options = request.options ?? request.choices ?? [];
		const title = request.title ?? request.message ?? "Select an option";
		const description = request.description ?? "";

		this.extensionDialog = {
			id,
			type: "select",
			title,
			description,
			options: options.map((opt, idx) => ({
				value:
					typeof opt === "string"
						? opt
						: (opt.value ?? opt.label ?? String(idx)),
				label:
					typeof opt === "string"
						? opt
						: (opt.label ?? opt.value ?? String(idx)),
				description: typeof opt === "object" ? (opt.description ?? "") : "",
			})),
			selectedValue: null,
			timeoutId: null,
		};

		if (timeout > 0) {
			this.extensionDialog.timeoutId = setTimeout(() => {
				this.dismissDialog(null);
			}, timeout);
		}
	},

	showConfirmDialog(id, request, timeout) {
		const title = request.title ?? request.message ?? "Confirm";
		const description = request.description ?? request.text ?? "";
		const confirmLabel = request.confirmLabel ?? request.yesLabel ?? "Yes";
		const cancelLabel = request.cancelLabel ?? request.noLabel ?? "No";

		this.extensionDialog = {
			id,
			type: "confirm",
			title,
			description,
			confirmLabel,
			cancelLabel,
			timeoutId: null,
		};

		if (timeout > 0) {
			this.extensionDialog.timeoutId = setTimeout(() => {
				this.dismissDialog(false);
			}, timeout);
		}
	},

	showInputDialog(id, request, timeout) {
		const title = request.title ?? request.message ?? "Input";
		const description = request.description ?? "";
		const placeholder = request.placeholder ?? "";
		const defaultValue = request.defaultValue ?? request.value ?? "";

		this.extensionDialog = {
			id,
			type: "input",
			title,
			description,
			placeholder,
			inputValue: defaultValue,
			timeoutId: null,
		};

		if (timeout > 0) {
			this.extensionDialog.timeoutId = setTimeout(() => {
				this.dismissDialog(null);
			}, timeout);
		}
	},

	showEditorDialog(id, request, timeout) {
		const title = request.title ?? request.message ?? "Edit";
		const description = request.description ?? "";
		const content = request.content ?? request.value ?? request.text ?? "";
		const language = request.language ?? "";

		this.extensionDialog = {
			id,
			type: "editor",
			title,
			description,
			language,
			editorContent: content,
			timeoutId: null,
		};

		if (timeout > 0) {
			this.extensionDialog.timeoutId = setTimeout(() => {
				this.dismissDialog(null);
			}, timeout);
		}
	},

	selectDialogOption(option) {
		if (!this.extensionDialog || this.extensionDialog.type !== "select") {
			return;
		}
		this.sendExtensionUIResponse(this.extensionDialog.id, option.value);
		this.closeDialog();
	},

	confirmDialogYes() {
		if (!this.extensionDialog || this.extensionDialog.type !== "confirm") {
			return;
		}
		this.sendExtensionUIResponse(this.extensionDialog.id, true);
		this.closeDialog();
	},

	confirmDialogNo() {
		if (!this.extensionDialog || this.extensionDialog.type !== "confirm") {
			return;
		}
		this.sendExtensionUIResponse(this.extensionDialog.id, false);
		this.closeDialog();
	},

	submitInputDialog() {
		if (!this.extensionDialog || this.extensionDialog.type !== "input") {
			return;
		}
		this.sendExtensionUIResponse(
			this.extensionDialog.id,
			this.extensionDialog.inputValue,
		);
		this.closeDialog();
	},
};
