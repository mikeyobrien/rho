import path from "node:path";
import { pathToFileURL } from "node:url";

let PASS = 0;
let FAIL = 0;

function assert(condition: boolean, label: string): void {
  if (condition) {
    console.log(`  PASS: ${label}`);
    PASS++;
    return;
  }
  console.error(`  FAIL: ${label}`);
  FAIL++;
}

function assertEq(actual: unknown, expected: unknown, label: string): void {
  const ok = Object.is(actual, expected);
  if (ok) {
    console.log(`  PASS: ${label}`);
    PASS++;
    return;
  }
  console.error(`  FAIL: ${label} (expected ${String(expected)}, got ${String(actual)})`);
  FAIL++;
}

console.log("\n=== Web Chat Slash Contract Tests ===\n");

const contractPath = path.resolve(import.meta.dirname!, "../web/public/js/slash-contract.js");
await import(pathToFileURL(contractPath).href);

const contract = (globalThis as any).__rhoSlashContract;
if (!contract) {
  console.error("  FAIL: slash contract loaded on globalThis");
  process.exit(1);
}

console.log("-- command index + supported classification --");
{
  const commands = contract.normalizeCommandsPayload({
    commands: [
      { name: "review", source: "extension" },
      { name: "skill:triage", source: "skill" },
    ],
  });
  const index = contract.buildCommandIndex(commands);
  const supported = contract.classifySlashCommand("/review this file", index);
  const mentionQualified = contract.classifySlashCommand("/review@my_bot this file", index);

  assertEq(commands.length, 2, "normalizes command payload entries");
  assertEq(supported.kind, "supported", "supported command classified as supported");
  assertEq(supported.commandName, "review", "extracts slash command name");
  assertEq(supported.commandSource, "extension", "keeps command source for queue semantics");
  assertEq(mentionQualified.kind, "supported", "mention-qualified slash command remains supported");
  assertEq(mentionQualified.commandName, "review", "mention-qualified slash command strips @bot target");
}

console.log("\n-- unsupported and interactive-only guardrails --");
{
  const index = contract.buildCommandIndex([]);
  const interactiveOnly = contract.classifySlashCommand("/settings", index);
  const unsupported = contract.classifySlashCommand("/nope", index);
  const statusShortcut = contract.classifySlashCommand("/status", index);
  const checkShortcut = contract.classifySlashCommand("/check", index);

  assertEq(interactiveOnly.kind, "interactive_only", "flags TUI-only slash command");
  assert(
    contract.formatUnsupportedMessage(interactiveOnly).includes("interactive TUI"),
    "interactive-only message explains TUI limitation",
  );

  assertEq(unsupported.kind, "unsupported", "flags unknown slash command");
  assert(
    contract.formatUnsupportedMessage(unsupported).includes("get_commands"),
    "unsupported message points to RPC command inventory",
  );

  assertEq(statusShortcut.kind, "unsupported", "flags /status shortcut as unsupported when not in inventory");
  assert(
    contract.formatUnsupportedMessage(statusShortcut).includes("Try /telegram status"),
    "/status unsupported message suggests canonical telegram status command",
  );

  assertEq(checkShortcut.kind, "unsupported", "flags /check shortcut as unsupported when not in inventory");
  assert(
    contract.formatUnsupportedMessage(checkShortcut).includes("Try /telegram check"),
    "/check unsupported message suggests canonical telegram check command",
  );
}

console.log("\n-- slash prompt failure mapping --");
{
  const slash = "/telegram check";
  const timeout = contract.formatPromptFailure(slash, "RPC prompt timed out after 20s");
  const busy = contract.formatPromptFailure(slash, "session is busy");
  const unsupported = contract.formatPromptFailure(slash, "Unknown command: /telegram");
  const statusShortcutUnsupported = contract.formatPromptFailure("/status", "Unknown command: /status");

  assert(timeout.includes("timed out"), "timeout failures map to retry guidance");
  assert(busy.includes("session is busy"), "busy failures map to busy guidance");
  assert(unsupported.includes("get_commands"), "unsupported failures point to get_commands inventory");
  assert(
    statusShortcutUnsupported.includes("Try /telegram status"),
    "prompt failure for /status suggests canonical telegram status command",
  );
}

console.log("\n-- streaming prompt option semantics --");
{
  const index = contract.buildCommandIndex([
    { name: "review", source: "extension" },
    { name: "skill:triage", source: "skill" },
  ]);

  const ext = contract.classifySlashCommand("/review", index);
  const skill = contract.classifySlashCommand("/skill:triage", index);

  const extStreaming = contract.resolvePromptOptions(ext, true, "steer");
  const skillStreaming = contract.resolvePromptOptions(skill, true, "steer");
  const skillIdle = contract.resolvePromptOptions(skill, false, "steer");

  assertEq(Object.keys(extStreaming).length, 0, "extension slash during streaming keeps immediate prompt semantics");
  assertEq(skillStreaming.streamingBehavior, "steer", "non-extension slash during streaming uses prompt queue semantics");
  assertEq(Object.keys(skillIdle).length, 0, "idle slash prompt sends without streamingBehavior");
}

console.log(`\n=== Results: ${PASS} passed, ${FAIL} failed ===\n`);
process.exit(FAIL > 0 ? 1 : 0);
