/**
 * Rho Extension - OpenClaw-style periodic check-ins for pi
 *
 * Rho runs periodic "heartbeat" turns where the agent checks on:
 * - Outstanding tasks and follow-ups
 * - RHO.md checklist in workspace
 * - Anything needing attention
 *
 * Named after the Greek letter ρ (rho), representing continuous presence.
 *
 * Usage:
 *   /rho status           - Show current rho state
 *   /rho enable           - Enable rho check-ins
 *   /rho disable          - Disable rho check-ins
 *   /rho now              - Trigger a check-in immediately
 *   /rho interval 30m     - Set interval (e.g., 30m, 1h, 0 to disable)
 *   /rho model auto       - Use the main session's model for heartbeat
 *   /rho model <p>/<m>    - Pin a specific model for heartbeat
 *
 * The LLM can also use tools:
 *   - rho_control(action: "enable" | "disable" | "trigger" | "interval" | "model", interval?: string, model?: string)
 *   - rho_status()
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { StringEnum } from "@mariozechner/pi-ai";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { execSync } from "node:child_process";
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { buildHeartbeatSection } from "./tasks-core.ts";

// State stored in memory (reconstructed from session entries and persisted to disk)
interface RhoState {
	enabled: boolean;
	intervalMs: number;
	lastCheckAt: number | null;
	nextCheckAt: number | null;
	checkCount: number;
	heartbeatModel: string | null; // null = auto-resolve, "provider/model" = pinned
}

// Cached result of auto-resolved heartbeat model (not persisted)
interface ResolvedModel {
	provider: string;
	model: string;
	cost: number; // output cost per M tokens
	resolvedAt: number;
}

interface RhoDetails {
	action: "enable" | "disable" | "trigger" | "interval" | "status" | "model";
	intervalMs?: number;
	enabled?: boolean;
	lastCheckAt?: number | null;
	nextCheckAt?: number | null;
	checkCount?: number;
	wasTriggered?: boolean;
	heartbeatModel?: string | null;
	heartbeatModelSource?: "auto" | "pinned";
	heartbeatModelCost?: number;
}

const DEFAULT_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
const MIN_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes minimum
const MAX_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours maximum

const RHO_DIR = join(process.env.HOME || "", ".rho");
const LEGACY_STATE_PATH = join(process.env.HOME || "", ".pi", "agent", "rho-state.json");
const STATE_PATH = join(RHO_DIR, "rho-state.json");
const RESULTS_DIR = join(process.env.HOME || "", ".rho", "results");
const HEARTBEAT_PROMPT_FILE = join(process.env.HOME || "", ".rho", "heartbeat-prompt.txt");
const DEFAULT_SESSION_NAME = "rho";
const HEARTBEAT_WINDOW_NAME = "heartbeat";
const MAX_WINDOW_NAME = 50;

const RHO_PROMPT = `This is a rho check-in. Review the following:

1. Read RHO.md and HEARTBEAT.md from the workspace if they exist - follow any checklists or scheduled tasks there
2. Check for any outstanding tasks, TODOs, or follow-ups from our conversation
3. Review any long-running operations or background processes
4. Surface anything urgent that needs attention

If nothing needs attention, reply with exactly: RHO_OK
If something needs attention, reply with the alert (do NOT include RHO_OK).
If the user asks for scheduled tasks or recurring reminders, add them to HEARTBEAT.md.`;

export default function (pi: ExtensionAPI) {
	if (process.env.RHO_SUBAGENT === "1") {
		return;
	}

	// In-memory state (reconstructed from session)
	let state: RhoState = {
		enabled: true,
		intervalMs: DEFAULT_INTERVAL_MS,
		lastCheckAt: null,
		nextCheckAt: null,
		checkCount: 0,
		heartbeatModel: null,
	};

	let timer: NodeJS.Timeout | null = null;
	let cachedModel: ResolvedModel | null = null;
	const MODEL_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

	const normalizeInterval = (value: unknown): number => {
		if (typeof value !== "number" || Number.isNaN(value)) return DEFAULT_INTERVAL_MS;
		if (value === 0) return 0;
		if (value < MIN_INTERVAL_MS || value > MAX_INTERVAL_MS) return DEFAULT_INTERVAL_MS;
		return Math.floor(value);
	};

	/**
	 * Resolve the cheapest available model across all providers for heartbeat use.
	 * Returns provider/model strings suitable for --provider and --model CLI flags.
	 * Returns null if resolution fails (caller should omit flags and use pi defaults).
	 */
	const resolveHeartbeatModel = async (ctx: ExtensionContext): Promise<ResolvedModel | null> => {
		// If pinned, parse and return the pinned model
		if (state.heartbeatModel) {
			const parts = state.heartbeatModel.split("/");
			if (parts.length === 2) {
				// Verify the pinned model still has auth
				const model = ctx.modelRegistry.find(parts[0], parts[1]);
				if (model) {
					const apiKey = await ctx.modelRegistry.getApiKey(model);
					if (apiKey) {
						return { provider: parts[0], model: parts[1], cost: model.cost.output, resolvedAt: Date.now() };
					}
				}
				// Pinned model unavailable -- fall through to auto-resolve
			}
		}

		// Use cache if fresh
		if (cachedModel && (Date.now() - cachedModel.resolvedAt) < MODEL_CACHE_TTL_MS) {
			return cachedModel;
		}

		try {
			// Get all models with valid auth, sorted by output cost (cheapest first)
			const available = ctx.modelRegistry.getAvailable();
			if (!available.length) return null;

			const sorted = [...available].sort((a, b) => a.cost.output - b.cost.output);

			// Try cheapest models until we find one with a working API key
			for (const candidate of sorted) {
				const apiKey = await ctx.modelRegistry.getApiKey(candidate);
				if (apiKey) {
					cachedModel = {
						provider: candidate.provider,
						model: candidate.id,
						cost: candidate.cost.output,
						resolvedAt: Date.now(),
					};
					return cachedModel;
				}
			}
		} catch {
			// Model resolution failed -- not critical
		}

		return null;
	};

	const loadStateFromDisk = () => {
		// Migrate legacy state from ~/.pi/agent/rho-state.json
		try {
			if (!existsSync(STATE_PATH) && existsSync(LEGACY_STATE_PATH)) {
				mkdirSync(RHO_DIR, { recursive: true });
				const legacyRaw = readFileSync(LEGACY_STATE_PATH, "utf-8");
				writeFileSync(STATE_PATH, legacyRaw);
			}
		} catch { /* ignore migration errors */ }

		try {
			const raw = readFileSync(STATE_PATH, "utf-8");
			const parsed = JSON.parse(raw) as Partial<RhoState>;
			if (typeof parsed.enabled === "boolean") state.enabled = parsed.enabled;
			if (parsed.intervalMs !== undefined) state.intervalMs = normalizeInterval(parsed.intervalMs);
			if (typeof parsed.lastCheckAt === "number") state.lastCheckAt = parsed.lastCheckAt;
			if (typeof parsed.nextCheckAt === "number") state.nextCheckAt = parsed.nextCheckAt;
			if (typeof parsed.checkCount === "number" && parsed.checkCount >= 0) state.checkCount = parsed.checkCount;
			if (parsed.heartbeatModel === null || typeof parsed.heartbeatModel === "string") {
				state.heartbeatModel = parsed.heartbeatModel;
			}
		} catch {
			// Ignore missing or invalid state
		}

		if (state.intervalMs === 0) state.enabled = false;
	};

	const saveStateToDisk = () => {
		try {
			mkdirSync(RHO_DIR, { recursive: true });
			writeFileSync(
				STATE_PATH,
				JSON.stringify(
					{
						enabled: state.enabled,
						intervalMs: state.intervalMs,
						lastCheckAt: state.lastCheckAt,
						nextCheckAt: state.nextCheckAt,
						checkCount: state.checkCount,
						heartbeatModel: state.heartbeatModel,
					},
					null,
					2
				)
			);
		} catch {
			// Ignore persistence failures
		}
	};

	/**
	 * Reconstruct state from session entries
	 */
	const reconstructState = (ctx: ExtensionContext) => {
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "message") continue;
			const msg = entry.message;
			if (msg.role !== "toolResult" || msg.toolName !== "rho_control") continue;

			const details = msg.details as RhoDetails | undefined;
			if (details) {
				if (details.enabled !== undefined) state.enabled = details.enabled;
				if (details.intervalMs !== undefined) state.intervalMs = details.intervalMs;
				if (details.lastCheckAt !== undefined) state.lastCheckAt = details.lastCheckAt;
				if (details.nextCheckAt !== undefined) state.nextCheckAt = details.nextCheckAt;
				if (details.checkCount !== undefined) state.checkCount = details.checkCount;
				if (details.heartbeatModel !== undefined) state.heartbeatModel = details.heartbeatModel;
			}
		}
	};

	/**
	 * Parse interval string (e.g., "30m", "1h", "15min")
	 */
	const parseInterval = (input: string): number | null => {
		const match = input.trim().toLowerCase().match(/^(\d+)\s*(m|min|minute|minutes|h|hr|hour|hours)?$/);
		if (!match) return null;

		const value = parseInt(match[1], 10);
		const unit = match[2] || "m";

		if (unit.startsWith("h")) {
			return value * 60 * 60 * 1000;
		}
		return value * 60 * 1000;
	};

	/**
	 * Format interval for display
	 */
	const formatInterval = (ms: number): string => {
		if (ms >= 60 * 60 * 1000) {
			const hours = ms / (60 * 60 * 1000);
			return `${hours}h`;
		}
		const minutes = ms / (60 * 1000);
		return `${minutes}m`;
	};

	const shellEscape = (value: string): string => `'${value.replace(/'/g, "'\"'\"'")}'`;

	const sanitizeWindowName = (value: string): string => {
		const cleaned = value.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, MAX_WINDOW_NAME);
		return cleaned || "subagent";
	};

	const ensureResultsDir = () => {
		try {
			mkdirSync(RESULTS_DIR, { recursive: true });
		} catch {
			// Ignore errors
		}
	};

	const getTmuxSessionName = (): string => {
		if (!process.env.TMUX) return DEFAULT_SESSION_NAME;
		try {
			const name = execSync("tmux display-message -p '#S'", { encoding: "utf-8" }).trim();
			return name || DEFAULT_SESSION_NAME;
		} catch {
			return DEFAULT_SESSION_NAME;
		}
	};

	const heartbeatWindowExists = (sessionName: string): boolean => {
		try {
			const output = execSync(`tmux list-windows -t ${shellEscape(sessionName)} -F "#{window_name}"`, {
				encoding: "utf-8",
			});
			return output
				.split("\n")
				.map((name) => name.trim())
				.filter(Boolean)
				.includes(HEARTBEAT_WINDOW_NAME);
		} catch {
			return false;
		}
	};

	const ensureTmuxSession = (sessionName: string): boolean => {
		try {
			execSync(`tmux has-session -t ${shellEscape(sessionName)}`, { stdio: "ignore" });
			return true;
		} catch {
			try {
				execSync(`tmux new-session -d -s ${shellEscape(sessionName)}`, { stdio: "ignore" });
				return true;
			} catch {
				return false;
			}
		}
	};

	const runHeartbeatInTmux = (prompt: string, modelFlags?: string): boolean => {
		try {
			execSync("command -v tmux", { stdio: "ignore" });
		} catch {
			return false;
		}

		const sessionName = getTmuxSessionName();
		if (!ensureTmuxSession(sessionName)) {
			return false;
		}

		try {
			ensureResultsDir();
			writeFileSync(HEARTBEAT_PROMPT_FILE, prompt, "utf-8");
		} catch {
			return false;
		}

		const target = `${sessionName}:${HEARTBEAT_WINDOW_NAME}`;
		const promptArg = `@${HEARTBEAT_PROMPT_FILE}`;
		const flags = modelFlags ? ` ${modelFlags}` : "";
		const command = `clear; RHO_SUBAGENT=1 pi --no-session${flags} ${shellEscape(promptArg)}; rm -f ${shellEscape(HEARTBEAT_PROMPT_FILE)}`;

		try {
			if (!heartbeatWindowExists(sessionName)) {
				execSync(
					`tmux new-window -d -t ${shellEscape(sessionName)} -n ${shellEscape(HEARTBEAT_WINDOW_NAME)}`,
					{ stdio: "ignore" }
				);
			}

			execSync(`tmux send-keys -t ${shellEscape(target)} C-c`, { stdio: "ignore" });
			execSync(`tmux send-keys -t ${shellEscape(target)} ${shellEscape(command)} C-m`, { stdio: "ignore" });
			return true;
		} catch {
			return false;
		}
	};

	/**
	 * Schedule the next check-in
	 */
	const scheduleNext = (ctx: ExtensionContext) => {
		if (timer) {
			clearTimeout(timer);
			timer = null;
		}

		if (!state.enabled || state.intervalMs === 0) {
			state.nextCheckAt = null;
			saveStateToDisk();
			return;
		}

		const now = Date.now();
		const base = state.lastCheckAt && state.lastCheckAt <= now ? state.lastCheckAt : now;
		let nextAt = base + state.intervalMs;
		if (nextAt <= now) {
			nextAt = now + 1000;
		}
		state.nextCheckAt = nextAt;

		const delay = Math.max(0, nextAt - now);
		timer = setTimeout(() => {
			triggerCheck(ctx);
		}, delay);

		saveStateToDisk();
	};

	/**
	 * Read a markdown file from a list of candidate paths
	 */
	const readMarkdownFile = (paths: string[]): string | null => {
		for (const filePath of paths) {
			if (existsSync(filePath)) {
				try {
					const content = readFileSync(filePath, "utf-8").trim();
					// Check if effectively empty (only whitespace and headers)
					const hasContent = content
						.split("\n")
						.some((line) => {
							const trimmed = line.trim();
							if (!trimmed || trimmed.startsWith("#")) return false;
							if (trimmed.startsWith("-")) {
								return /^-\s*\[[ xX]\]/.test(trimmed);
							}
							return true;
						});
					return hasContent ? content : null;
				} catch {
					continue;
				}
			}
		}
		return null;
	};

	/**
	 * Build --provider/--model/--thinking CLI flags for the heartbeat subagent.
	 * Default: use the same model as the main session.
	 * Falls back to auto-resolve if the main model is unavailable.
	 */
	const buildModelFlags = async (ctx: ExtensionContext): Promise<string> => {
		// If pinned via /rho model, use that
		if (state.heartbeatModel) {
			const parts = state.heartbeatModel.split("/");
			if (parts.length === 2) {
				const model = ctx.modelRegistry.find(parts[0], parts[1]);
				if (model) {
					const apiKey = await ctx.modelRegistry.getApiKey(model);
					if (apiKey) {
						let flags = `--provider ${shellEscape(parts[0])} --model ${shellEscape(parts[1])}`;
						flags += " --thinking off";
						return flags;
					}
				}
			}
		}

		// Default: inherit the main session's model
		if (ctx.model) {
			const apiKey = await ctx.modelRegistry.getApiKey(ctx.model);
			if (apiKey) {
				let flags = `--provider ${shellEscape(ctx.model.provider)} --model ${shellEscape(ctx.model.id)}`;
				flags += " --thinking off";
				return flags;
			}
		}

		// Fallback: auto-resolve cheapest available
		try {
			const resolved = await resolveHeartbeatModel(ctx);
			if (resolved) {
				let flags = `--provider ${shellEscape(resolved.provider)} --model ${shellEscape(resolved.model)}`;
				flags += " --thinking off";
				return flags;
			}
		} catch {
			// not critical
		}

		return "";
	};

	/**
	 * Trigger a check-in immediately
	 */
	const triggerCheck = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;

		state.lastCheckAt = Date.now();
		state.checkCount++;

		// Build the full prompt with RHO.md / HEARTBEAT.md content if available
		let fullPrompt = RHO_PROMPT;
		const rhoMd = readMarkdownFile([
			join(ctx.cwd, "RHO.md"),
			join(ctx.cwd, ".pi", "RHO.md"),
			join(ctx.cwd, ".rho.md"),
		]);
		const heartbeatMd = readMarkdownFile([
			join(ctx.cwd, "HEARTBEAT.md"),
			join(ctx.cwd, ".pi", "HEARTBEAT.md"),
			join(ctx.cwd, ".heartbeat.md"),
			join(ctx.cwd, ".rho-heartbeat.md"),
		]);
		// Build tasks section from task queue
		let tasksSection: string | null = null;
		try {
			tasksSection = buildHeartbeatSection();
		} catch {
			// Tasks module not available or error -- not critical
		}

		if (!rhoMd && !heartbeatMd && !tasksSection) {
			scheduleNext(ctx);
			return;
		}
		if (rhoMd) {
			fullPrompt += `\n\n---\n\nRHO.md content:\n${rhoMd}`;
		}
		if (heartbeatMd) {
			fullPrompt += `\n\n---\n\nHEARTBEAT.md content:\n${heartbeatMd}`;
		}
		if (tasksSection) {
			fullPrompt += `\n\n---\n\n${tasksSection}`;
		}

		// Resolve model (session model > pinned > auto) async, then dispatch
		buildModelFlags(ctx).then((modelFlags) => {
			const sentToTmux = runHeartbeatInTmux(fullPrompt, modelFlags || undefined);
			if (!sentToTmux) {
				// Send as user message (appears as system event style)
				pi.sendUserMessage(fullPrompt, { deliverAs: "followUp" });
			}
		}).catch(() => {
			// Fallback: no model flags
			const sentToTmux = runHeartbeatInTmux(fullPrompt);
			if (!sentToTmux) {
				pi.sendUserMessage(fullPrompt, { deliverAs: "followUp" });
			}
		});

		// Schedule next
		scheduleNext(ctx);
	};

	/**
	 * Update status line
	 */
	const updateStatus = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;

		const theme = ctx.ui.theme;
		if (!state.enabled || state.intervalMs === 0) {
			ctx.ui.setStatus("rho", theme.fg("dim", "ρ off"));
			return;
		}

		const interval = formatInterval(state.intervalMs);
		if (state.nextCheckAt) {
			const mins = Math.ceil((state.nextCheckAt - Date.now()) / (60 * 1000));
			ctx.ui.setStatus("rho", theme.fg("dim", `ρ ${interval} (${mins}m)`));
		} else {
			ctx.ui.setStatus("rho", theme.fg("dim", `ρ ${interval}`));
		}
	};

	// Reconstruct state on session events
	pi.on("session_start", async (_event, ctx) => {
		loadStateFromDisk();
		reconstructState(ctx);
		scheduleNext(ctx);
		updateStatus(ctx);
	});

	pi.on("session_switch", async (_event, ctx) => {
		loadStateFromDisk();
		reconstructState(ctx);
		scheduleNext(ctx);
		updateStatus(ctx);
	});

	pi.on("session_fork", async (_event, ctx) => {
		loadStateFromDisk();
		reconstructState(ctx);
		scheduleNext(ctx);
		updateStatus(ctx);
	});

	// Clean up on shutdown
	pi.on("session_shutdown", async () => {
		if (timer) {
			clearTimeout(timer);
			timer = null;
		}
	});

	// Detect RHO_OK responses and show a notification (no suppression)
	pi.on("agent_end", async (event, ctx) => {
		const lastMessage = event.messages[event.messages.length - 1];
		if (lastMessage?.role === "assistant" && lastMessage.content) {
			const text = lastMessage.content
				.filter((c) => c.type === "text")
				.map((c) => c.text)
				.join("");

			// Check for RHO_OK at start or end
			const trimmed = text.trim();
			const isRhoOk =
				trimmed === "RHO_OK" ||
				trimmed.startsWith("RHO_OK\n") ||
				trimmed.endsWith("\nRHO_OK");

			if (isRhoOk && trimmed.length <= 300) {
				// Notify that the check-in is OK
				ctx.ui.notify("ρ: OK (no alerts)", "info");
			}
		}

		// Update status after each turn
		updateStatus(ctx);
	});

	// Register rho_control tool for the LLM
	pi.registerTool({
		name: "rho_control",
		label: "Rho",
		description: "Control the rho check-in system. Actions: enable, disable, trigger (immediate), status (get info), interval (set with interval string like '30m' or '1h'), model (set heartbeat model: 'auto' or 'provider/model-id')",
		parameters: Type.Object({
			action: StringEnum(["enable", "disable", "trigger", "status", "interval", "model"] as const),
			interval: Type.Optional(Type.String({ description: "Interval string for 'interval' action (e.g., '30m', '1h', '15min'). Use '0' to disable." })),
			model: Type.Optional(Type.String({ description: "Model for 'model' action. 'auto' to use session model, or 'provider/model-id' to pin." })),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			switch (params.action) {
				case "enable":
					state.enabled = true;
					scheduleNext(ctx);
					updateStatus(ctx);
					return {
						content: [{ type: "text", text: "Rho enabled" }],
						details: { action: "enable", enabled: state.enabled } as RhoDetails,
					};

				case "disable":
					state.enabled = false;
					scheduleNext(ctx);
					updateStatus(ctx);
					return {
						content: [{ type: "text", text: "Rho disabled" }],
						details: { action: "disable", enabled: state.enabled } as RhoDetails,
					};

				case "trigger":
					if (!ctx.hasUI) {
						return {
							content: [{ type: "text", text: "Error: Cannot trigger rho in non-interactive mode" }],
							details: { action: "trigger", wasTriggered: false } as RhoDetails,
						};
					}
					triggerCheck(ctx);
					return {
						content: [{ type: "text", text: "Rho check-in triggered" }],
						details: {
							action: "trigger",
							wasTriggered: true,
							lastCheckAt: state.lastCheckAt,
							checkCount: state.checkCount,
						} as RhoDetails,
					};

				case "interval": {
					if (!params.interval) {
						return {
							content: [{ type: "text", text: `Current interval: ${formatInterval(state.intervalMs)}` }],
							details: {
								action: "interval",
								intervalMs: state.intervalMs,
							} as RhoDetails,
						};
					}

					const intervalMs = parseInterval(params.interval);
					if (intervalMs === null) {
						return {
							content: [{ type: "text", text: `Error: Invalid interval '${params.interval}'. Use format like '30m', '1h', or '0' to disable.` }],
							details: { action: "interval", intervalMs: state.intervalMs, error: "invalid interval" } as RhoDetails,
						};
					}

					if (intervalMs !== 0 && (intervalMs < MIN_INTERVAL_MS || intervalMs > MAX_INTERVAL_MS)) {
						return {
							content: [{ type: "text", text: `Error: Interval must be between 5m and 24h (or 0 to disable)` }],
							details: { action: "interval", intervalMs: state.intervalMs, error: "out of range" } as RhoDetails,
						};
					}

					state.intervalMs = intervalMs;
					if (intervalMs === 0) {
						state.enabled = false;
					}
					scheduleNext(ctx);
					updateStatus(ctx);

					const status = intervalMs === 0 ? "disabled" : `set to ${formatInterval(intervalMs)}`;
					return {
						content: [{ type: "text", text: `Rho interval ${status}` }],
						details: {
							action: "interval",
							intervalMs: state.intervalMs,
							enabled: state.enabled,
						} as RhoDetails,
					};
				}

				case "status": {
					const rhoMd = readMarkdownFile([
						join(ctx.cwd, "RHO.md"),
						join(ctx.cwd, ".pi", "RHO.md"),
						join(ctx.cwd, ".rho.md"),
					]);

					// Resolve heartbeat model for display
					let hbModelText: string;
					let hbModelSource: "auto" | "pinned" = "auto";
					let hbModelCost: number | undefined;
					if (state.heartbeatModel) {
						hbModelSource = "pinned";
						hbModelText = `${state.heartbeatModel} (pinned)`;
						const parts = state.heartbeatModel.split("/");
						if (parts.length === 2) {
							const m = ctx.modelRegistry.find(parts[0], parts[1]);
							if (m) hbModelCost = m.cost.output;
						}
					} else if (ctx.model) {
						hbModelText = `${ctx.model.provider}/${ctx.model.id} (session)`;
						hbModelCost = ctx.model.cost.output;
					} else {
						hbModelText = "auto";
					}

					let text = `Rho status:\n`;
					text += `- Enabled: ${state.enabled}\n`;
					text += `- Interval: ${formatInterval(state.intervalMs)}\n`;
					text += `- Heartbeat model: ${hbModelText}\n`;
					text += `- Total check-ins this session: ${state.checkCount}\n`;
					if (state.lastCheckAt) {
						const ago = Math.floor((Date.now() - state.lastCheckAt) / (60 * 1000));
						text += `- Last check-in: ${ago}m ago\n`;
					} else {
						text += `- Last check-in: never\n`;
					}
					if (state.nextCheckAt && state.enabled && state.intervalMs > 0) {
						const inMins = Math.ceil((state.nextCheckAt - Date.now()) / (60 * 1000));
						text += `- Next check-in: in ${inMins}m\n`;
					}
					text += `- RHO.md: ${rhoMd ? "found" : "not found"}`;

					return {
						content: [{ type: "text", text }],
						details: {
							action: "status",
							enabled: state.enabled,
							intervalMs: state.intervalMs,
							lastCheckAt: state.lastCheckAt,
							nextCheckAt: state.nextCheckAt,
							checkCount: state.checkCount,
							heartbeatModel: state.heartbeatModel,
							heartbeatModelSource: hbModelSource,
							heartbeatModelCost: hbModelCost,
						} as RhoDetails,
					};
				}

				case "model": {
					const modelArg = params.model?.trim();
					if (!modelArg) {
						const source = state.heartbeatModel ? "pinned" : "auto";
						return {
							content: [{ type: "text", text: `Heartbeat model: ${state.heartbeatModel || "auto"} (${source})` }],
							details: {
								action: "model",
								heartbeatModel: state.heartbeatModel,
								heartbeatModelSource: source,
							} as RhoDetails,
						};
					}

					if (modelArg === "auto") {
						state.heartbeatModel = null;
						cachedModel = null;
						saveStateToDisk();
						return {
							content: [{ type: "text", text: "Heartbeat model set to auto (uses session model)" }],
							details: {
								action: "model",
								heartbeatModel: null,
								heartbeatModelSource: "auto",
							} as RhoDetails,
						};
					}

					// Validate provider/model format
					const parts = modelArg.split("/");
					if (parts.length !== 2) {
						return {
							content: [{ type: "text", text: `Error: Model must be 'provider/model-id' or 'auto'. Got: '${modelArg}'` }],
							details: { action: "model" } as RhoDetails,
						};
					}

					// Verify model exists
					const model = ctx.modelRegistry.find(parts[0], parts[1]);
					if (!model) {
						return {
							content: [{ type: "text", text: `Error: Model '${modelArg}' not found. Use --list-models to see available models.` }],
							details: { action: "model" } as RhoDetails,
						};
					}

					state.heartbeatModel = modelArg;
					saveStateToDisk();
					return {
						content: [{ type: "text", text: `Heartbeat model pinned to ${modelArg} ($${model.cost.output}/M output)` }],
						details: {
							action: "model",
							heartbeatModel: modelArg,
							heartbeatModelSource: "pinned",
							heartbeatModelCost: model.cost.output,
						} as RhoDetails,
					};
				}
			}
		},

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("rho ")) + theme.fg("muted", args.action);
			if (args.interval) {
				text += ` ${theme.fg("accent", args.interval)}`;
			}
			if (args.model) {
				text += ` ${theme.fg("accent", args.model)}`;
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme) {
			const details = result.details as RhoDetails | undefined;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}

			if (details.action === "status") {
				return new Text(theme.fg("dim", `ρ ${formatInterval(details.intervalMs || DEFAULT_INTERVAL_MS)}`), 0, 0);
			}

			if (details.action === "trigger") {
				return new Text(theme.fg("success", "✓ Triggered"), 0, 0);
			}

			const status = details.enabled ? theme.fg("success", "on") : theme.fg("dim", "off");
			return new Text(theme.fg("success", "✓ ") + theme.fg("muted", `${details.action} `) + status, 0, 0);
		},
	});

	// Register rho_subagent tool
	pi.registerTool({
		name: "rho_subagent",
		label: "Subagent",
		description:
			"Run a pi subagent in a new tmux window (session 'rho' by default). Default mode is interactive; print mode writes results to ~/.rho/results.",
		parameters: Type.Object({
			prompt: Type.String({ description: "Prompt to run in the subagent" }),
			session: Type.Optional(Type.String({ description: "tmux session name (default: rho)" })),
			window: Type.Optional(Type.String({ description: "tmux window name (auto-generated if omitted)" })),
			mode: Type.Optional(StringEnum(["interactive", "print"] as const)),
			outputFile: Type.Optional(Type.String({ description: "Output file path (print mode only; default: ~/.rho/results/<timestamp>.json)" })),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const prompt = params.prompt?.trim();
			if (!prompt) {
				return { content: [{ type: "text", text: "Error: prompt required" }], details: { error: true } };
			}

			try {
				execSync("command -v tmux", { stdio: "ignore" });
			} catch {
				return { content: [{ type: "text", text: "Error: tmux not installed" }], details: { error: true } };
			}

			const sessionName = (params.session || DEFAULT_SESSION_NAME).trim() || DEFAULT_SESSION_NAME;
		const mode = (params.mode || "interactive").trim().toLowerCase();
		if (mode !== "interactive" && mode !== "print") {
			return { content: [{ type: "text", text: "Error: mode must be 'interactive' or 'print'" }], details: { error: true } };
		}

			try {
				execSync(`tmux has-session -t ${shellEscape(sessionName)}`, { stdio: "ignore" });
			} catch {
				return {
					content: [{ type: "text", text: `Error: tmux session '${sessionName}' not found` }],
					details: { error: true },
				};
			}

			ensureResultsDir();

			const windowSeed = new Date().toISOString().slice(11, 16).replace(":", "");
			const windowName = sanitizeWindowName(params.window?.trim() || `subagent-${windowSeed}`);

			const outputFileRaw = params.outputFile?.trim();
			const outputFile = outputFileRaw
				? outputFileRaw.startsWith("/")
					? outputFileRaw
					: join(ctx.cwd, outputFileRaw)
				: join(RESULTS_DIR, `${Date.now()}.json`);

			// Inherit the main session's model for subagents
			let modelFlags = "";
			if (ctx.model) {
				modelFlags = ` --provider ${shellEscape(ctx.model.provider)} --model ${shellEscape(ctx.model.id)}`;
			}

			const shellPath = process.env.SHELL || "bash";
			const script =
				mode === "print"
					? `RHO_SUBAGENT=1 pi -p --no-session${modelFlags} ${shellEscape(prompt)} 2>&1 | tee ${shellEscape(outputFile)}; exec ${shellEscape(shellPath)}`
					: `RHO_SUBAGENT=1 pi --no-session${modelFlags} ${shellEscape(prompt)}; exec ${shellEscape(shellPath)}`;
			const innerCommand = `bash -lc ${shellEscape(script)}`;
			const tmuxCommand = `tmux new-window -d -P -F "#{session_name}:#{window_index}" -t ${shellEscape(sessionName)} -n ${shellEscape(windowName)} ${shellEscape(innerCommand)}`;

			let windowId = "";
			try {
				windowId = execSync(tmuxCommand, { encoding: "utf-8" }).trim();
				if (windowId) {
					execSync(`tmux set-option -t ${shellEscape(windowId)} remain-on-exit on`, { stdio: "ignore" });
				}
			} catch {
				return {
					content: [{ type: "text", text: "Error: failed to create tmux window" }],
					details: { error: true },
				};
			}

			const message =
				mode === "print"
					? `Started subagent in ${windowId} (output: ${outputFile})`
					: `Started subagent in ${windowId} (interactive mode)`;
			return {
				content: [{ type: "text", text: message }],
				details: { session: sessionName, window: windowId, outputFile: mode === "print" ? outputFile : undefined, mode },
			};
		},
	});

	// Register /rho command
	pi.registerCommand("rho", {
		description: "Control rho check-in system: status, enable, disable, now, interval <time>, model <auto|provider/model>",
		handler: async (args, ctx) => {
			const [subcmd, ...rest] = args.trim().split(/\s+/);
			const arg = rest.join(" ");

			switch (subcmd) {
				case "status":
				case "": {
					let modelInfo: string;
					if (state.heartbeatModel) {
						modelInfo = `${state.heartbeatModel} (pinned)`;
					} else if (ctx.model) {
						modelInfo = `${ctx.model.provider}/${ctx.model.id} (session)`;
					} else {
						modelInfo = "auto";
					}
					ctx.ui.notify(
						`Rho: ${state.enabled ? "enabled" : "disabled"}, ` +
						`interval: ${formatInterval(state.intervalMs)}, ` +
						`model: ${modelInfo}, ` +
						`count: ${state.checkCount}`,
						"info"
					);
					break;
				}

				case "enable":
					state.enabled = true;
					scheduleNext(ctx);
					updateStatus(ctx);
					ctx.ui.notify("Rho enabled", "success");
					break;

				case "disable":
					state.enabled = false;
					scheduleNext(ctx);
					updateStatus(ctx);
					ctx.ui.notify("Rho disabled", "info");
					break;

				case "now":
					if (!ctx.hasUI) {
						ctx.ui.notify("Rho requires interactive mode", "error");
						return;
					}
					triggerCheck(ctx);
					ctx.ui.notify("Rho check-in triggered", "success");
					break;

				case "interval": {
					if (!arg) {
						ctx.ui.notify(`Current interval: ${formatInterval(state.intervalMs)}`, "info");
						return;
					}
					const intervalMs = parseInterval(arg);
					if (intervalMs === null) {
						ctx.ui.notify("Invalid interval. Use format: 30m, 1h, or 0 to disable", "error");
						return;
					}
					if (intervalMs !== 0 && (intervalMs < MIN_INTERVAL_MS || intervalMs > MAX_INTERVAL_MS)) {
						ctx.ui.notify("Interval must be between 5m and 24h", "error");
						return;
					}
					state.intervalMs = intervalMs;
					if (intervalMs === 0) state.enabled = false;
					scheduleNext(ctx);
					updateStatus(ctx);
					ctx.ui.notify(
						intervalMs === 0
							? "Rho disabled (interval = 0)"
							: `Rho interval set to ${formatInterval(intervalMs)}`,
						"success"
					);
					break;
				}

				case "model": {
					if (!arg) {
						let modelDisplay: string;
						if (state.heartbeatModel) {
							modelDisplay = `${state.heartbeatModel} (pinned)`;
						} else if (ctx.model) {
							modelDisplay = `${ctx.model.provider}/${ctx.model.id} (session)`;
						} else {
							modelDisplay = "auto";
						}
						ctx.ui.notify(`Heartbeat model: ${modelDisplay}`, "info");
						return;
					}

					if (arg === "auto") {
						state.heartbeatModel = null;
						cachedModel = null;
						saveStateToDisk();
						ctx.ui.notify("Heartbeat model set to auto (uses session model)", "success");
						return;
					}

					const parts = arg.split("/");
					if (parts.length !== 2) {
						ctx.ui.notify("Usage: /rho model auto  OR  /rho model provider/model-id", "error");
						return;
					}

					const model = ctx.modelRegistry.find(parts[0], parts[1]);
					if (!model) {
						ctx.ui.notify(`Model '${arg}' not found`, "error");
						return;
					}

					state.heartbeatModel = arg;
					saveStateToDisk();
					ctx.ui.notify(`Heartbeat model pinned to ${arg} ($${model.cost.output}/M output)`, "success");
					break;
				}

				default:
					ctx.ui.notify("Usage: /rho [status|enable|disable|now|interval|model]", "warning");
					ctx.ui.notify("Examples: /rho now, /rho interval 30m, /rho model auto", "info");
			}
		},
	});
}
