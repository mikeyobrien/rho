/**
 * Tasker Extension - Android UI automation via Tasker + AutoInput
 *
 * Architecture:
 *   Termux sends intents → Tasker receives, performs action → writes result to file
 *   Termux watches result file → returns to caller
 *
 * Requires:
 *   - Tasker app with AutoInput plugin
 *   - Tasker profiles listening for rho.tasker.* intents
 *   - See docs/tasker-setup.md for profile configuration
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";

// Paths - Use shared storage so Tasker can write results
const RHO_DIR = "/storage/emulated/0/rho";
const RESULT_FILE = path.join(RHO_DIR, "tasker-result.json");
const SCREENSHOT_DIR = path.join(RHO_DIR, "screenshots");

interface TaskerResult {
  success: boolean;
  clicked?: string;
  typed?: string;
  path?: string;
  texts?: string;
  error?: string;
  [key: string]: unknown;
}

// Ensure directories exist
function ensureDirs(): void {
  if (!fs.existsSync(RHO_DIR)) fs.mkdirSync(RHO_DIR, { recursive: true });
  if (!fs.existsSync(SCREENSHOT_DIR)) fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
}

// Clear result file before sending command
function clearResult(): void {
  try {
    if (fs.existsSync(RESULT_FILE)) fs.unlinkSync(RESULT_FILE);
  } catch {
    // Ignore errors
  }
}

// Wait for result file to appear (with timeout)
async function waitForResult(timeoutMs = 10000): Promise<TaskerResult> {
  const start = Date.now();
  const pollInterval = 100;

  while (Date.now() - start < timeoutMs) {
    if (fs.existsSync(RESULT_FILE)) {
      try {
        const content = fs.readFileSync(RESULT_FILE, "utf-8");
        return JSON.parse(content) as TaskerResult;
      } catch {
        // File exists but not valid JSON yet, keep waiting
      }
    }
    await new Promise((r) => setTimeout(r, pollInterval));
  }

  return { success: false, error: "Timeout waiting for Tasker response" };
}

// Send intent to Tasker via am broadcast
function sendIntent(action: string, extras: Record<string, string>): void {
  const args = ["broadcast", "--user", "0", "-a", `rho.tasker.${action}`];

  for (const [key, value] of Object.entries(extras)) {
    args.push("-e", key, value);
  }

  try {
    execSync(`am ${args.map((a) => `"${a}"`).join(" ")}`, { stdio: "ignore" });
  } catch (err) {
    throw new Error(`Failed to send intent: ${err}`);
  }
}

// Execute a Tasker command and wait for result
async function taskerCommand(
  action: string,
  params: Record<string, string>,
  timeoutMs = 10000
): Promise<TaskerResult> {
  ensureDirs();
  clearResult();

  // Add result file path so Tasker knows where to write
  params.result_file = RESULT_FILE;

  sendIntent(action, params);
  return waitForResult(timeoutMs);
}

export default function (pi: ExtensionAPI) {
  ensureDirs();

  // Register tasker tool for UI automation
  pi.registerTool({
    name: "tasker",
    label: "Tasker",
    description:
      "Control Android UI via Tasker. Actions: open_url, click, type, screenshot, read_screen. Use for browser automation, app interaction, or screen capture.",
    parameters: Type.Object({
      action: StringEnum(["open_url", "click", "type", "screenshot", "read_screen", "back", "home"] as const),
      url: Type.Optional(Type.String({ description: "URL to open (for open_url)" })),
      target: Type.Optional(Type.String({ description: "Text or element ID to click/target" })),
      text: Type.Optional(Type.String({ description: "Text to type (for type action)" })),
      timeout: Type.Optional(Type.Number({ description: "Timeout in ms (default: 10000)" })),
    }),

    async execute(_toolCallId, params, _onUpdate, _ctx) {
      const timeout = params.timeout || 10000;

      try {
        let result: TaskerResult;

        switch (params.action) {
          case "open_url": {
            if (!params.url) {
              return { content: [{ type: "text", text: "Error: url required" }], details: { error: true } };
            }
            result = await taskerCommand("open_url", { url: params.url }, timeout);
            break;
          }

          case "click": {
            if (!params.target) {
              return { content: [{ type: "text", text: "Error: target required" }], details: { error: true } };
            }
            result = await taskerCommand("click", { target: params.target }, timeout);
            break;
          }

          case "type": {
            if (!params.text) {
              return { content: [{ type: "text", text: "Error: text required" }], details: { error: true } };
            }
            result = await taskerCommand("type", { text: params.text, target: params.target || "" }, timeout);
            break;
          }

          case "screenshot": {
            const filename = `screenshot-${Date.now()}.png`;
            const filepath = path.join(SCREENSHOT_DIR, filename);
            result = await taskerCommand("screenshot", { output: filepath }, timeout);
            break;
          }

          case "read_screen": {
            result = await taskerCommand("read_screen", {}, timeout);
            break;
          }

          case "back": {
            result = await taskerCommand("back", {}, timeout);
            break;
          }

          case "home": {
            result = await taskerCommand("home", {}, timeout);
            break;
          }

          default:
            return { content: [{ type: "text", text: `Unknown action: ${params.action}` }], details: { error: true } };
        }

        if (result.success) {
          return {
            content: [{ type: "text", text: JSON.stringify(result) }],
            details: result,
          };
        } else {
          return {
            content: [{ type: "text", text: `Error: ${result.error || "unknown"}` }],
            details: { error: true, ...result },
          };
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text", text: `Error: ${message}` }], details: { error: true } };
      }
    },
  });

  // Register /tasker command for manual testing
  pi.registerCommand("tasker", {
    description: "Test Tasker integration (usage: /tasker <action> [args])",
    handler: async (args, ctx) => {
      const parts = args?.trim().split(/\s+/) || [];
      const action = parts[0];

      if (!action) {
        ctx.ui.notify("Usage: /tasker <open_url|click|type|screenshot|read_screen|back|home> [args]", "error");
        return;
      }

      ctx.ui.notify(`Sending: ${action}...`, "info");

      try {
        let result: TaskerResult;

        switch (action) {
          case "open_url":
            result = await taskerCommand("open_url", { url: parts[1] || "https://example.com" });
            break;
          case "click":
            result = await taskerCommand("click", { target: parts.slice(1).join(" ") || "OK" });
            break;
          case "type":
            result = await taskerCommand("type", { text: parts.slice(1).join(" ") || "hello" });
            break;
          case "screenshot": {
            const filepath = path.join(SCREENSHOT_DIR, `screenshot-${Date.now()}.png`);
            result = await taskerCommand("screenshot", { output: filepath });
            break;
          }
          case "read_screen":
            result = await taskerCommand("read_screen", {});
            break;
          case "back":
            result = await taskerCommand("back", {});
            break;
          case "home":
            result = await taskerCommand("home", {});
            break;
          default:
            ctx.ui.notify(`Unknown action: ${action}`, "error");
            return;
        }

        if (result.success) {
          ctx.ui.notify(`✓ ${action}`, "success");
        } else {
          ctx.ui.notify(`✗ ${result.error}`, "error");
        }
      } catch (err) {
        ctx.ui.notify(`Error: ${err}`, "error");
      }
    },
  });
}
