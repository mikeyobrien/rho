import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  buildCommandIndex as buildTelegramCommandIndex,
  classifySlashCommand as classifyTelegramSlash,
  formatSlashPromptFailure,
  formatUnsupportedMessage as formatTelegramUnsupported,
} from "../extensions/telegram/slash-contract.ts";

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
  if (Object.is(actual, expected)) {
    console.log(`  PASS: ${label}`);
    PASS++;
    return;
  }
  console.error(`  FAIL: ${label} (expected ${String(expected)}, got ${String(actual)})`);
  FAIL++;
}

console.log("\n=== Cross-Channel Slash Contract Parity Tests ===\n");

const webContractPath = path.resolve(import.meta.dirname!, "../web/public/js/slash-contract.js");
await import(pathToFileURL(webContractPath).href);
const webContract = (globalThis as any).__rhoSlashContract;
if (!webContract) {
  console.error("  FAIL: web slash contract loaded on globalThis");
  process.exit(1);
}

const inventory = [
  { name: "telegram", source: "extension" },
  { name: "skill:triage", source: "skill" },
];

console.log("-- parity: slash classification decisions --");
{
  const webIndex = webContract.buildCommandIndex(inventory);
  const telegramIndex = buildTelegramCommandIndex(inventory);

  const inputs = ["/telegram status", "/telegram@tau_rhobot status", "/settings", "/nope"];
  for (const input of inputs) {
    const web = webContract.classifySlashCommand(input, webIndex);
    const telegram = classifyTelegramSlash(input, telegramIndex);
    assertEq(telegram.kind, web.kind, `classification kind matches for ${input}`);
    assertEq(telegram.commandName, web.commandName, `commandName matches for ${input}`);
  }
}

console.log("\n-- parity: unsupported/interative error text --");
{
  const webIndex = webContract.buildCommandIndex(inventory);
  const telegramIndex = buildTelegramCommandIndex(inventory);

  const cases = ["/settings", "/nope", "/status", "/check"];
  for (const input of cases) {
    const web = webContract.classifySlashCommand(input, webIndex);
    const telegram = classifyTelegramSlash(input, telegramIndex);

    const webMessage = webContract.formatUnsupportedMessage(web);
    const telegramMessage = formatTelegramUnsupported(telegram);
    assertEq(telegramMessage, webMessage, `unsupported message matches for ${input}`);
  }

  const statusShortcutMessage = formatTelegramUnsupported(
    classifyTelegramSlash("/status", telegramIndex),
  );
  assert(
    statusShortcutMessage.includes("Try /telegram status"),
    "shortcut unsupported text suggests canonical telegram status command",
  );
}

console.log("\n-- parity: prompt failure categories --");
{
  const slash = "/telegram check";
  const cases = [
    "Unknown command: /telegram",
    "session is busy",
    "RPC prompt timed out after 20s",
    "something broke",
  ];

  for (const raw of cases) {
    const webMessage = webContract.formatPromptFailure(slash, raw);
    const telegramMessage = formatSlashPromptFailure(slash, raw);
    assertEq(telegramMessage, webMessage, `prompt failure mapping matches for error: ${raw}`);
  }

  const webStatusShortcut = webContract.formatPromptFailure("/status", "Unknown command: /status");
  const telegramStatusShortcut = formatSlashPromptFailure("/status", "Unknown command: /status");
  assertEq(telegramStatusShortcut, webStatusShortcut, "shortcut prompt failure message parity for /status");

  const nonSlash = "hello";
  assertEq(
    formatSlashPromptFailure(nonSlash, "rpc failure"),
    "rpc failure",
    "non-slash failures stay unchanged in telegram helper",
  );
}

console.log(`\n=== Results: ${PASS} passed, ${FAIL} failed ===\n`);
process.exit(FAIL > 0 ? 1 : 0);
