import * as primitives from "./constants-and-primitives.js";
import * as modelThinking from "./model-thinking-and-toast.js";
import * as renderingUsage from "./rendering-and-usage.js";
import * as toolSemantics from "./tool-semantics.js";

const {
	clampString,
	extractText,
	toFiniteNumber,
	parseUsageTotals,
	normalizeThinkingLevel,
	thinkingLevelsForModel,
} = { ...primitives, ...toolSemantics, ...renderingUsage, ...modelThinking };

export const rhoChatSlashAndStatsMethods = {
	messageForkPreview(message) {
		const firstText = message?.parts?.find((part) => part.type === "text");
		const text = firstText ? extractText(firstText.content ?? "") : "";
		return (
			clampString(text.replace(/\s+/g, " ").trim(), 80) ||
			"Fork from this prompt"
		);
	},

	// Chat controls methods

	// --- Slash autocomplete ---

	updateSlashAutocomplete() {
		const text = this.promptText;

		// Only trigger when text starts with "/" and is on a single line
		if (!text.startsWith("/") || text.startsWith("//") || text.includes("\n")) {
			this.closeSlashAutocomplete();
			return;
		}

		if (!this.slashCommandsLoaded) {
			this.requestSlashCommands();
			this.closeSlashAutocomplete();
			return;
		}

		const query = text.slice(1).toLowerCase();
		const MAX_ITEMS = 15;

		const filtered = this.slashCommands
			.filter((cmd) => cmd.name.toLowerCase().includes(query))
			.slice(0, MAX_ITEMS);

		if (filtered.length === 0) {
			this.slashAcItems = [];
			this.slashAcVisible =
				query.length > 0 ? true : this.slashCommands.length > 0;
			this.slashAcIndex = -1;
			if (!this.slashAcVisible) this.closeSlashAutocomplete();
			return;
		}

		this.slashAcItems = filtered;
		this.slashAcVisible = true;

		// Clamp index to new bounds
		if (this.slashAcIndex >= filtered.length) {
			this.slashAcIndex = 0;
		}
		if (this.slashAcIndex < 0) {
			this.slashAcIndex = 0;
		}

		// Scroll active item into view
		this.$nextTick(() => {
			const dropdown = this.$refs.slashAcDropdown;
			if (!dropdown) return;
			const active = dropdown.querySelector(".slash-ac-item.active");
			if (active) {
				active.scrollIntoView({ block: "nearest" });
			}
		});
	},

	closeSlashAutocomplete() {
		this.slashAcVisible = false;
		this.slashAcItems = [];
		this.slashAcIndex = 0;
	},

	selectSlashCommand(item) {
		if (!item) return;
		this.promptText = `/${item.name} `;
		this.closeSlashAutocomplete();
		this.$nextTick(() => {
			const input = this.$refs.composerInput;
			if (input) {
				input.focus();
				// Move cursor to end
				input.selectionStart = input.selectionEnd = input.value.length;
				// Reset textarea height
				input.style.height = "auto";
				input.style.height = `${Math.min(input.scrollHeight, 200)}px`;
			}
		});
	},

	handleSlashAcKeydown(e) {
		if (!this.slashAcVisible) return false;

		if (e.key === "ArrowDown") {
			e.preventDefault();
			if (this.slashAcItems.length > 0) {
				this.slashAcIndex = (this.slashAcIndex + 1) % this.slashAcItems.length;
				this.$nextTick(() => {
					const dropdown = this.$refs.slashAcDropdown;
					if (!dropdown) return;
					const active = dropdown.querySelector(".slash-ac-item.active");
					if (active) active.scrollIntoView({ block: "nearest" });
				});
			}
			return true;
		}

		if (e.key === "ArrowUp") {
			e.preventDefault();
			if (this.slashAcItems.length > 0) {
				this.slashAcIndex =
					(this.slashAcIndex - 1 + this.slashAcItems.length) %
					this.slashAcItems.length;
				this.$nextTick(() => {
					const dropdown = this.$refs.slashAcDropdown;
					if (!dropdown) return;
					const active = dropdown.querySelector(".slash-ac-item.active");
					if (active) active.scrollIntoView({ block: "nearest" });
				});
			}
			return true;
		}

		if (e.key === "Tab") {
			e.preventDefault();
			if (this.slashAcItems.length > 0 && this.slashAcIndex >= 0) {
				this.selectSlashCommand(this.slashAcItems[this.slashAcIndex]);
			}
			return true;
		}

		if (e.key === "Enter" && !e.shiftKey) {
			if (this.slashAcItems.length > 0 && this.slashAcIndex >= 0) {
				e.preventDefault();
				this.selectSlashCommand(this.slashAcItems[this.slashAcIndex]);
				return true;
			}
			// No items or no selection — let normal Enter/submit flow through
			this.closeSlashAutocomplete();
			return false;
		}

		if (e.key === "Escape") {
			e.preventDefault();
			this.closeSlashAutocomplete();
			return true;
		}

		return false;
	},

	requestSlashCommands(force = false) {
		if (!this.activeRpcSessionId) {
			return;
		}
		if (this.slashCommandsLoading) {
			return;
		}
		if (!force && this.slashCommandsLoaded && this.slashCommandIndex.size > 0) {
			return;
		}

		this.slashCommandsLoading = true;
		const sent = this.sendWs({
			type: "rpc_command",
			sessionId: this.activeRpcSessionId,
			command: { type: "get_commands" },
		});

		if (!sent) {
			this.slashCommandsLoading = false;
		}
	},

	requestState() {
		if (!this.activeRpcSessionId) {
			return;
		}
		this.sendWs({
			type: "rpc_command",
			sessionId: this.activeRpcSessionId,
			command: { type: "get_state" },
		});
	},

	requestAvailableModels() {
		if (!this.activeRpcSessionId) {
			return;
		}
		this.sendWs({
			type: "rpc_command",
			sessionId: this.activeRpcSessionId,
			command: { type: "get_available_models" },
		});
	},

	requestSessionStats() {
		if (!this.activeRpcSessionId) {
			return;
		}
		this.sendWs({
			type: "rpc_command",
			sessionId: this.activeRpcSessionId,
			command: { type: "get_session_stats" },
		});
	},

	syncThinkingLevels() {
		const levels = thinkingLevelsForModel(
			this.currentModel,
			this.availableModels,
		);
		this.thinkingLevels = levels;
		const normalized = normalizeThinkingLevel(this.currentThinkingLevel);
		if (!levels.includes(normalized)) {
			this.currentThinkingLevel = levels.includes("medium")
				? "medium"
				: (levels[0] ?? "off");
			return;
		}
		this.currentThinkingLevel = normalized;
	},

	resolveInterruptedStreamState() {
		if (!this.awaitingStreamReconnectState) {
			return;
		}

		this.awaitingStreamReconnectState = false;

		if (this.isStreaming) {
			this.showReconnectBanner = true;
			this.reconnectBannerMessage = "Reconnected — agent is still responding.";
			return;
		}

		if (this.streamDisconnectedDuringResponse) {
			this.showReconnectBanner = true;
			this.reconnectBannerMessage =
				"Reconnected — previous response may be incomplete. Reloading…";
			this.streamDisconnectedDuringResponse = false;
			this.$nextTick(() => this.reloadActiveSession());
			setTimeout(() => {
				if (!this.isStreaming && this.isWsConnected) {
					this.showReconnectBanner = false;
					this.reconnectBannerMessage = "";
				}
			}, 2200);
			return;
		}

		this.showReconnectBanner = false;
		this.reconnectBannerMessage = "";
	},

	handleStateUpdate(state) {
		if (state.model) {
			this.currentModel = state.model;
		}
		if (state.thinkingLevel) {
			this.currentThinkingLevel = normalizeThinkingLevel(state.thinkingLevel);
		}
		if (typeof state.isStreaming === "boolean") {
			this.isStreaming = state.isStreaming;
		}
		if (!this.isStreaming) {
			this.isSendingPrompt = false;
		}
		this.resolveInterruptedStreamState();
		this.syncThinkingLevels();
		this.updateFooter();
	},

	handleSessionStatsUpdate(stats) {
		const statsObj = stats && typeof stats === "object" ? stats : {};
		const tok = statsObj.tokens;
		const tokObj = tok && typeof tok === "object" ? tok : null;

		const inputTokens =
			toFiniteNumber(statsObj.inputTokens) ??
			toFiniteNumber(
				tokObj?.input ?? tokObj?.promptTokens ?? tokObj?.inputTokens,
			) ??
			0;
		const outputTokens =
			toFiniteNumber(statsObj.outputTokens) ??
			toFiniteNumber(
				tokObj?.output ?? tokObj?.completionTokens ?? tokObj?.outputTokens,
			) ??
			0;
		const cacheRead =
			toFiniteNumber(statsObj.cacheRead) ??
			toFiniteNumber(statsObj.cacheReadTokens) ??
			toFiniteNumber(tokObj?.cacheRead ?? tokObj?.cache_read) ??
			0;
		const cacheWrite =
			toFiniteNumber(statsObj.cacheWrite) ??
			toFiniteNumber(statsObj.cacheCreation) ??
			toFiniteNumber(tokObj?.cacheWrite ?? tokObj?.cache_write) ??
			0;

		const totalTokens =
			toFiniteNumber(statsObj.totalTokens) ??
			toFiniteNumber(statsObj.tokenUsage) ??
			toFiniteNumber(statsObj.tokensTotal) ??
			toFiniteNumber(
				tokObj?.total ??
					tokObj?.totalTokens ??
					tokObj?.total_tokens ??
					tokObj?.tokens,
			) ??
			toFiniteNumber(tok) ??
			inputTokens + outputTokens + cacheRead + cacheWrite;

		const cost =
			toFiniteNumber(statsObj.totalCost) ??
			toFiniteNumber(statsObj.costTotal) ??
			toFiniteNumber(statsObj.cost?.total) ??
			toFiniteNumber(statsObj.cost) ??
			0;

		const currentTokens = toFiniteNumber(this.sessionStats?.tokens) ?? 0;
		const currentCost = toFiniteNumber(this.sessionStats?.cost) ?? 0;
		const currentInput = toFiniteNumber(this.sessionStats?.inputTokens) ?? 0;
		const currentOutput = toFiniteNumber(this.sessionStats?.outputTokens) ?? 0;
		const currentCacheRead = toFiniteNumber(this.sessionStats?.cacheRead) ?? 0;
		const currentCacheWrite =
			toFiniteNumber(this.sessionStats?.cacheWrite) ?? 0;

		const incomingAllZero =
			totalTokens === 0 &&
			cost === 0 &&
			inputTokens === 0 &&
			outputTokens === 0 &&
			cacheRead === 0 &&
			cacheWrite === 0;
		const hasCurrentUsage =
			currentTokens > 0 ||
			currentCost > 0 ||
			currentInput > 0 ||
			currentOutput > 0 ||
			currentCacheRead > 0 ||
			currentCacheWrite > 0;

		// Ignore transient zero snapshots from RPC startup that would
		// clobber stats already reconstructed from the loaded session.
		if (hasCurrentUsage && incomingAllZero) {
			return;
		}

		this.sessionStats = {
			tokens: Math.max(currentTokens, totalTokens),
			cost: Math.max(currentCost, cost),
			inputTokens: Math.max(currentInput, inputTokens),
			outputTokens: Math.max(currentOutput, outputTokens),
			cacheRead: Math.max(currentCacheRead, cacheRead),
			cacheWrite: Math.max(currentCacheWrite, cacheWrite),
		};
		this.updateFooter();
	},

	syncSessionStatsFromSession(session, messages = []) {
		const sessionStats = session?.stats ?? {};
		const tokensFromSession =
			toFiniteNumber(sessionStats.totalTokens) ??
			toFiniteNumber(sessionStats.tokenUsage) ??
			toFiniteNumber(sessionStats.tokens);
		const costFromSession =
			toFiniteNumber(sessionStats.totalCost) ??
			toFiniteNumber(sessionStats.cost?.total) ??
			toFiniteNumber(sessionStats.cost);

		let inputTokens = 0;
		let outputTokens = 0;
		let cacheRead = 0;
		let cacheWrite = 0;
		let tokensFromMessages = 0;
		let costFromMessages = 0;

		const usageMessages = Array.isArray(messages) ? messages : [];
		for (const message of usageMessages) {
			const totals = parseUsageTotals(message?.usage);
			inputTokens += totals.input;
			outputTokens += totals.output;
			cacheRead += totals.cacheRead;
			cacheWrite += totals.cacheWrite;
			tokensFromMessages += totals.total;
			costFromMessages += totals.cost ?? 0;
		}

		this.sessionStats = {
			tokens: tokensFromSession ?? tokensFromMessages,
			cost: costFromSession ?? costFromMessages,
			inputTokens,
			outputTokens,
			cacheRead,
			cacheWrite,
		};
		this.updateFooter();
	},

	seedUsageAccumulator(messages = []) {
		this.usageAccountedMessageIds.clear();
		const usageMessages = Array.isArray(messages) ? messages : [];
		for (const message of usageMessages) {
			if (!message || message.role !== "assistant") {
				continue;
			}
			const messageId = String(message.id ?? "");
			if (!messageId) {
				continue;
			}
			const totals = parseUsageTotals(message.usage);
			const hasUsage =
				totals.input > 0 ||
				totals.output > 0 ||
				totals.cacheRead > 0 ||
				totals.cacheWrite > 0 ||
				totals.total > 0 ||
				(totals.cost ?? 0) > 0;
			if (hasUsage) {
				this.usageAccountedMessageIds.add(messageId);
			}
		}
	},
};
