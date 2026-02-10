/**
 * Agent SOP Extension for rho
 *
 * Discovers .sop.md files, registers /sop:name commands, collects parameters
 * via UI wizard, and injects the SOP into the agent conversation.
 *
 * SOP locations (first match wins):
 *   - Project: .pi/sops/*.sop.md
 *   - User:    ~/.pi/agent/sops/*.sop.md
 *   - Bundled: <rho>/sops/*.sop.md (ships with rho)
 *   - Custom:  paths via --sop-paths flag
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import { parseSOP, formatParameterSummary, formatStepOutline, type SOP } from "./parser.js";

// Resolve the bundled sops/ dir relative to this extension
const BUNDLED_SOP_DIR = path.resolve(import.meta.dirname ?? __dirname, "../../sops");

// ─── Parameter Resolution ───────────────────────────────────────────────────

/** Escape special regex metacharacters in a string. */
export function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Resolve cross-references between parameter values.
 * e.g., if project_dir = ".agents/{project_name}" and project_name = "foo",
 * project_dir resolves to ".agents/foo".
 *
 * Multi-pass: handles transitive refs (A → B → C). Caps at MAX_PASSES to
 * avoid infinite loops on circular references.
 */
export function resolveParamValues(params: Record<string, string>): Record<string, string> {
	const resolved = { ...params };
	const paramNames = Object.keys(resolved);
	const MAX_PASSES = 5;

	for (let pass = 0; pass < MAX_PASSES; pass++) {
		let changed = false;
		for (const key of paramNames) {
			let newValue = resolved[key];
			for (const name of paramNames) {
				if (name === key) continue;
				newValue = newValue.replace(
					new RegExp(`\\{${escapeRegExp(name)}\\}`, "g"),
					resolved[name],
				);
			}
			if (newValue !== resolved[key]) {
				resolved[key] = newValue;
				changed = true;
			}
		}
		if (!changed) break;
	}

	return resolved;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function discoverSOPs(dirs: string[]): Map<string, SOP> {
	const sops = new Map<string, SOP>();

	for (const dir of dirs) {
		const resolved = dir.replace(/^~/, process.env.HOME || "");
		if (!fs.existsSync(resolved)) continue;

		const stat = fs.statSync(resolved);
		if (stat.isFile() && resolved.endsWith(".sop.md")) {
			const content = fs.readFileSync(resolved, "utf-8");
			const sop = parseSOP(content, resolved);
			if (!sops.has(sop.name)) sops.set(sop.name, sop);
			continue;
		}

		if (!stat.isDirectory()) continue;

		try {
			for (const entry of fs.readdirSync(resolved)) {
				if (!entry.endsWith(".sop.md")) continue;
				const filePath = path.join(resolved, entry);
				try {
					const content = fs.readFileSync(filePath, "utf-8");
					const sop = parseSOP(content, filePath);
					if (!sops.has(sop.name)) sops.set(sop.name, sop);
				} catch {
					// Skip unreadable files
				}
			}
		} catch {
			// Skip unreadable dirs
		}
	}

	return sops;
}

// ─── Extension ──────────────────────────────────────────────────────────────

export default function agentSOPExtension(pi: ExtensionAPI) {
	let sops = new Map<string, SOP>();

	function loadSOPs(ctx?: ExtensionContext) {
		const cwd = ctx?.cwd ?? process.cwd();
		const dirs = [
			path.join(cwd, ".pi/sops"),        // project-local (highest priority)
			"~/.pi/agent/sops",                 // user global
			BUNDLED_SOP_DIR,                    // shipped with rho
		];

		const extraPaths = pi.getFlag("sop-paths") as string | undefined;
		if (extraPaths) {
			dirs.push(...extraPaths.split(":"));
		}

		sops = discoverSOPs(dirs);
	}

	// ─── Parameter Wizard ─────────────────────────────────────────────────

	async function collectParameters(
		sop: SOP,
		ctx: ExtensionContext,
	): Promise<Record<string, string> | null> {
		const params: Record<string, string> = {};

		if (sop.parameters.length === 0) return params;

		if (!ctx.hasUI) {
			for (const p of sop.parameters) {
				if (p.defaultValue) {
					params[p.name] = p.defaultValue;
				} else if (p.required) {
					return null;
				}
			}
			return params;
		}

		ctx.ui.notify(
			`SOP: ${sop.title}\n\nParameters:\n${formatParameterSummary(sop.parameters)}`,
			"info",
		);

		for (const param of sop.parameters) {
			const label = param.required
				? `${param.name} (required)`
				: `${param.name} (optional)`;
			const placeholder = param.defaultValue ?? "";

			if (param.options && param.options.length > 0) {
				const choice = await ctx.ui.select(`${param.name}:`, param.options);
				if (choice === undefined) return null;
				params[param.name] = choice;
				continue;
			}

			const value = await ctx.ui.input(label, placeholder);
			if (value === undefined) return null;

			if (value.trim()) {
				params[param.name] = value.trim();
			} else if (param.defaultValue) {
				params[param.name] = param.defaultValue;
			} else if (param.required) {
				ctx.ui.notify(`${param.name} is required`, "error");
				return null;
			}
		}

		return params;
	}

	// ─── SOP Execution ────────────────────────────────────────────────────

	async function startSOP(
		sop: SOP,
		ctx: ExtensionContext,
		args?: string,
	) {
		const params = await collectParameters(sop, ctx);
		if (!params) {
			ctx.ui.notify("SOP cancelled", "warning");
			return;
		}

		if (args?.trim() && sop.parameters.some((p) => p.name === "task_description")) {
			params.task_description = args.trim();
		}

		if (ctx.hasUI) {
			const outline = formatStepOutline(sop.steps);
			const ok = await ctx.ui.confirm(
				`Start SOP: ${sop.title}`,
				`Steps:\n${outline}\n\nProceed?`,
			);
			if (!ok) {
				ctx.ui.notify("SOP cancelled", "warning");
				return;
			}
		}

		const resolved = resolveParamValues(params);
		let sopContent = sop.rawContent;
		for (const [key, value] of Object.entries(resolved)) {
			sopContent = sopContent.replace(
				new RegExp(`\\{${escapeRegExp(key)}\\}`, "g"),
				() => value,
			);
		}

		pi.sendUserMessage(
			`Execute the following SOP. Follow the steps in order.\n\n---\n\n${sopContent}`,
		);
	}

	// ─── Flags ────────────────────────────────────────────────────────────

	pi.registerFlag("sop-paths", {
		description: "Colon-separated paths to additional SOP directories",
		type: "string",
		default: "",
	});

	// ─── Commands ─────────────────────────────────────────────────────────

	pi.registerCommand("sop", {
		description: "List available SOPs or run one: /sop [name] [args]. SOPs live in: .pi/sops/ (project), ~/.pi/agent/sops/ (user), ~/.rho/project/sops/ (bundled). To create a new SOP, run /sop create-sop.",
		handler: async (args, ctx) => {
			loadSOPs(ctx);

			if (!args?.trim()) {
				if (sops.size === 0) {
					ctx.ui.notify(
						"No SOPs found.\n\nPlace .sop.md files in:\n  .pi/sops/\n  ~/.pi/agent/sops/",
						"warning",
					);
					return;
				}

				const items = Array.from(sops.values()).map(
					(s) => `${s.name} — ${s.overview.slice(0, 80)}`,
				);

				if (ctx.hasUI) {
					const choice = await ctx.ui.select("Select SOP:", items);
					if (!choice) return;
					const name = choice.split(" — ")[0];
					const sop = sops.get(name);
					if (sop) await startSOP(sop, ctx);
				} else {
					ctx.ui.notify(
						`Available SOPs:\n${items.map((i) => `  ${i}`).join("\n")}`,
						"info",
					);
				}
				return;
			}

			const parts = args.trim().split(/\s+/);
			const name = parts[0];
			const rest = parts.slice(1).join(" ");

			const sop = sops.get(name);
			if (!sop) {
				ctx.ui.notify(`SOP not found: ${name}`, "error");
				return;
			}

			await startSOP(sop, ctx, rest);
		},
	});

	// ─── Events ───────────────────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		loadSOPs(ctx);

		for (const [name, sop] of sops) {
			pi.registerCommand(`sop:${name}`, {
				description: sop.overview.slice(0, 100),
				handler: async (args, cmdCtx) => {
					await startSOP(sop, cmdCtx, args ?? undefined);
				},
			});
		}
	});
}
