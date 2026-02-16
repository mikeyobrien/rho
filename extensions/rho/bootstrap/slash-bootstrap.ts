/**
 * extensions/rho/bootstrap/slash-bootstrap.ts
 *
 * Bridge `/bootstrap ...` slash commands in extension runtime to the rho CLI
 * bootstrap command surface for parity.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

export type NotifyLevel = "info" | "success" | "warning" | "error";

export interface BootstrapCliRunnerResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type BootstrapCliRunner = (args: string[]) => BootstrapCliRunnerResult;

export interface SlashBootstrapResult {
  ok: boolean;
  command: string;
  args: string[];
  payload?: Record<string, unknown>;
  notify: {
    text: string;
    level: NotifyLevel;
  };
  code: number;
}

const ALLOWED_COMMANDS = new Set([
  "status",
  "run",
  "reapply",
  "upgrade",
  "diff",
  "reset",
  "audit",
]);

function splitArgs(raw: string): string[] {
  return raw
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function parseJsonLoose(raw: string): Record<string, unknown> | null {
  const t = raw.trim();
  if (!t) return null;

  const parseObj = (candidate: string): Record<string, unknown> | null => {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // ignore parse errors; caller will try other candidates
    }
    return null;
  };

  const direct = parseObj(t);
  if (direct) return direct;

  // Try parsing standalone JSON lines (common when tools prepend warnings).
  const lines = t.split("\n").map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const parsed = parseObj(lines[i]);
    if (parsed) return parsed;
  }

  // Scan for balanced JSON objects and parse each; return the last valid object.
  const candidates: string[] = [];
  let depth = 0;
  let inString = false;
  let escaped = false;
  let start = -1;

  for (let i = 0; i < t.length; i++) {
    const ch = t[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === "{") {
      if (depth === 0) start = i;
      depth += 1;
      continue;
    }

    if (ch === "}") {
      if (depth > 0) {
        depth -= 1;
        if (depth === 0 && start >= 0) {
          candidates.push(t.slice(start, i + 1));
          start = -1;
        }
      }
    }
  }

  for (let i = candidates.length - 1; i >= 0; i--) {
    const parsed = parseObj(candidates[i]);
    if (parsed) return parsed;
  }

  return null;
}

function buildNotifyText(command: string, payload: Record<string, unknown> | null): { text: string; level: NotifyLevel } {
  if (!payload) {
    return { text: `bootstrap ${command}: done`, level: "info" };
  }

  if (command === "status") {
    const status = (payload.status as string | undefined) ?? "unknown";
    const version = (payload.version as string | null | undefined) ?? "(none)";
    const managedCount = typeof payload.managedCount === "number" ? payload.managedCount : 0;
    const lastOp = typeof payload.lastOperation === "string" ? payload.lastOperation : null;
    const lastResult = typeof payload.lastResult === "string" ? payload.lastResult : null;
    const lastAt = typeof payload.lastOperationAt === "string" ? payload.lastOperationAt : null;

    const lines = [`Bootstrap: ${status} · version: ${version}`, `Managed entries: ${managedCount}`];
    if (lastOp) {
      let line = `Last op: ${lastOp}`;
      if (lastResult) line += ` (${lastResult})`;
      if (lastAt) line += ` @ ${lastAt}`;
      lines.push(line);
    }

    return { text: lines.join("\n"), level: "info" };
  }

  if (command === "audit") {
    const events = Array.isArray(payload.events) ? payload.events.length : 0;
    return { text: `Bootstrap audit events: ${events}`, level: "info" };
  }

  if (command === "diff") {
    const counts = (payload.planCounts as Record<string, number> | undefined) ?? {};
    const add = counts.ADD ?? 0;
    const upd = counts.UPDATE ?? 0;
    const noop = counts.NOOP ?? 0;
    const skip = (counts.SKIP_USER_EDITED ?? 0) + (counts.SKIP_CONFLICT ?? 0);
    const dep = counts.DEPRECATE ?? 0;
    return {
      text: `Bootstrap diff: +${add} ~${upd} =${noop} skip:${skip} deprecate:${dep}`,
      level: "info",
    };
  }

  const msg = typeof payload.message === "string" && payload.message.trim()
    ? payload.message.trim()
    : `bootstrap ${command}: done`;

  return { text: msg, level: "success" };
}

export interface BootstrapCliArgsBuild {
  command: string;
  args: string[];
  unknownCommand?: string;
}

const BOOTSTRAP_USAGE_HINT =
  "Usage: /bootstrap [status|run|reapply|upgrade|diff|reset|audit]";

export function buildBootstrapCliArgs(rawArgs: string): BootstrapCliArgsBuild {
  const parts = splitArgs(rawArgs);
  const commandRaw = (parts[0] ?? "status").toLowerCase();
  const rest = parts.slice(1);

  if (!ALLOWED_COMMANDS.has(commandRaw)) {
    return {
      command: commandRaw,
      args: [],
      unknownCommand: commandRaw,
    };
  }

  const args = ["bootstrap", commandRaw, ...rest];

  if (commandRaw === "run" && !rest.includes("--non-interactive")) {
    args.push("--non-interactive");
  }

  if (!args.includes("--json")) {
    args.push("--json");
  }

  return { command: commandRaw, args };
}

export function handleBootstrapSlash(
  rawArgs: string,
  runner: BootstrapCliRunner,
): SlashBootstrapResult {
  const built = buildBootstrapCliArgs(rawArgs);

  if (built.unknownCommand) {
    return {
      ok: false,
      command: built.command,
      args: built.args,
      notify: {
        text: `Unknown /bootstrap subcommand: ${built.unknownCommand}\n${BOOTSTRAP_USAGE_HINT}`,
        level: "warning",
      },
      code: 2,
    };
  }

  const result = runner(built.args);
  const payload = parseJsonLoose(result.stdout);

  if (result.code !== 0) {
    const errorFromPayload = typeof payload?.error === "string" ? payload.error : undefined;
    const fallback = (result.stderr || result.stdout || "bootstrap command failed").trim();
    return {
      ok: false,
      command: built.command,
      args: built.args,
      payload: payload ?? undefined,
      notify: {
        text: errorFromPayload || fallback,
        level: "error",
      },
      code: result.code,
    };
  }

  return {
    ok: true,
    command: built.command,
    args: built.args,
    payload: payload ?? undefined,
    notify: buildNotifyText(built.command, payload),
    code: result.code,
  };
}

export function runBootstrapCliFromExtension(
  extensionDir: string,
  args: string[],
): BootstrapCliRunnerResult {
  const cliPath = path.resolve(extensionDir, "../../cli/index.ts");
  if (!fs.existsSync(cliPath)) {
    return {
      code: 1,
      stdout: "",
      stderr: `rho bootstrap bridge: cli not found at ${cliPath}`,
    };
  }

  const p = spawnSync(
    process.execPath,
    ["--experimental-strip-types", cliPath, ...args],
    {
      encoding: "utf-8",
      env: {
        ...process.env,
        NODE_NO_WARNINGS: "1",
      },
    },
  );

  return {
    code: p.status ?? 1,
    stdout: p.stdout ?? "",
    stderr: p.stderr ?? "",
  };
}
