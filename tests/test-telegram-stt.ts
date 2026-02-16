/**
 * Tests for telegram STT provider abstraction.
 * Run: npx tsx tests/test-telegram-stt.ts
 */

import {
  extractTranscriptText,
  createSttProvider,
  SttApiKeyMissingError,
} from "../extensions/telegram/stt.ts";

let PASS = 0;
let FAIL = 0;

function assert(condition: boolean, label: string): void {
  if (condition) {
    console.log(`  PASS: ${label}`);
    PASS++;
  } else {
    console.error(`  FAIL: ${label}`);
    FAIL++;
  }
}

function assertEq(actual: unknown, expected: unknown, label: string): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    console.log(`  PASS: ${label}`);
    PASS++;
  } else {
    console.error(`  FAIL: ${label} — got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
    FAIL++;
  }
}

console.log("\n=== Telegram STT tests ===\n");

try {
  // -- extractTranscriptText --
  console.log("-- extractTranscriptText --");

  assertEq(extractTranscriptText(null), "", "null returns empty string");
  assertEq(extractTranscriptText(undefined), "", "undefined returns empty string");
  assertEq(extractTranscriptText("string"), "", "non-object returns empty string");
  assertEq(extractTranscriptText(42), "", "number returns empty string");
  assertEq(extractTranscriptText({}), "", "empty object returns empty string");

  assertEq(extractTranscriptText({ text: "hello" }), "hello", "direct text field");
  assertEq(extractTranscriptText({ text: "  padded  " }), "padded", "trims direct text");
  assertEq(extractTranscriptText({ text: "" }), "", "empty text returns empty string");
  assertEq(extractTranscriptText({ text: 123 }), "", "non-string text is ignored");

  assertEq(extractTranscriptText({ transcript: "from transcript" }), "from transcript", "direct transcript field");
  assertEq(extractTranscriptText({ transcript: "  padded  " }), "padded", "trims direct transcript");

  assertEq(
    extractTranscriptText({ text: "first", transcript: "second" }),
    "first",
    "text takes precedence over transcript",
  );

  assertEq(
    extractTranscriptText({ result: { text: "nested result" } }),
    "nested result",
    "nested result.text",
  );
  assertEq(
    extractTranscriptText({ result: { text: "  padded  " } }),
    "padded",
    "trims nested result.text",
  );
  assertEq(
    extractTranscriptText({ result: {} }),
    "",
    "empty result object returns empty string",
  );

  assertEq(
    extractTranscriptText({ data: { text: "nested data" } }),
    "nested data",
    "nested data.text",
  );
  assertEq(
    extractTranscriptText({ data: { text: "  padded  " } }),
    "padded",
    "trims nested data.text",
  );

  assertEq(
    extractTranscriptText({ result: { text: "from result" }, data: { text: "from data" } }),
    "from result",
    "result.text takes precedence over data.text",
  );

  // -- SttApiKeyMissingError --
  console.log("\n-- SttApiKeyMissingError --");

  const err = new SttApiKeyMissingError("MY_API_KEY");
  assert(err instanceof Error, "SttApiKeyMissingError extends Error");
  assert(err instanceof SttApiKeyMissingError, "instanceof SttApiKeyMissingError");
  assertEq(err.envVar, "MY_API_KEY", "envVar property set correctly");
  assertEq(err.message, "MY_API_KEY is not set", "message format");
  assertEq(err.name, "SttApiKeyMissingError", "name property");

  // -- createSttProvider --
  console.log("\n-- createSttProvider --");

  const elevenlabs = createSttProvider({ provider: "elevenlabs", apiKeyEnv: "TEST_KEY" });
  assert(typeof elevenlabs.transcribe === "function", "elevenlabs provider has transcribe method");

  const openai = createSttProvider({ provider: "openai", apiKeyEnv: "TEST_KEY" });
  assert(typeof openai.transcribe === "function", "openai provider has transcribe method");

  let unknownThrew = false;
  try {
    createSttProvider({ provider: "unknown" as any, apiKeyEnv: "TEST_KEY" });
  } catch (e: any) {
    unknownThrew = true;
    assert(e.message.includes("unknown"), "unknown provider error includes provider name");
  }
  assert(unknownThrew, "unknown provider throws");
} catch (e) {
  console.error("Unhandled error:", e);
  FAIL++;
}

console.log(`\nResults: ${PASS} passed, ${FAIL} failed`);
if (FAIL > 0) process.exit(1);
