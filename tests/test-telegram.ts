/**
 * Tests for telegram extension helper library + API client.
 * Run: npx tsx tests/test-telegram.ts
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import {
  DEFAULT_SETTINGS,
  readTelegramSettings,
  loadRuntimeState,
  saveRuntimeState,
  advanceUpdateOffset,
  type TelegramSettings,
} from "../extensions/telegram/lib.ts";
import {
  Api,
  GrammyError,
  HttpError,
  downloadFile,
  isTelegramParseModeError,
  isRetryableAfterAutoRetry,
  queueRetryDelayMs,
} from "../extensions/telegram/api.ts";
import { authorizeInbound, normalizeInboundUpdate, selectBestPhoto } from "../extensions/telegram/router.ts";
import { loadSessionMap, resolveSessionFile, sessionKeyForEnvelope } from "../extensions/telegram/session-map.ts";
import { TelegramRpcRunner } from "../extensions/telegram/rpc.ts";
import { chunkTelegramText, renderOutboundText, renderTelegramOutboundChunks } from "../extensions/telegram/outbound.ts";
import { appendTelegramLog } from "../extensions/telegram/log.ts";
import { loadOperatorConfig, saveOperatorConfig } from "../extensions/telegram/operator-config.ts";
import {
  createTelegramPollLeadershipState,
  releaseTelegramPollLeadership,
  stepTelegramPollLeadership,
} from "../extensions/telegram/poll-leadership.ts";
import {
  consumeTelegramCheckTrigger,
  getTelegramCheckTriggerState,
  requestTelegramCheckTrigger,
} from "../extensions/telegram/check-trigger.ts";
import { renderTelegramStatusText, renderTelegramUiStatus } from "../extensions/telegram/status.ts";
import { formatSlashAcknowledgement } from "../extensions/telegram/slash-contract.ts";

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

function createGrammyApiError(description: string, errorCode: number, retryAfterSeconds?: number): GrammyError {
  return new GrammyError(
    description,
    {
      ok: false,
      error_code: errorCode,
      description,
      parameters: typeof retryAfterSeconds === "number" ? { retry_after: retryAfterSeconds } : {},
    } as any,
    "sendMessage",
    {},
  );
}

console.log("\n=== Telegram helper tests ===\n");

const tmp = mkdtempSync(join(tmpdir(), "rho-telegram-test-"));
try {
  console.log("-- readTelegramSettings defaults --");
  {
    const settings = readTelegramSettings(join(tmp, "missing.toml"));
    assert(settings.enabled === false, "enabled defaults false");
    assert(settings.mode === "polling", "mode defaults polling");
    assert(settings.botTokenEnv === "TELEGRAM_BOT_TOKEN", "default token env");
    assert(settings.pollTimeoutSeconds === 30, "default poll timeout");
    assert(settings.rpcPromptTimeoutSeconds === 60, "default rpc prompt timeout");
    assert(settings.backgroundPromptTimeoutSeconds === 900, "default background prompt timeout");
    assert(settings.requireMentionInGroups === true, "default group mention requirement");
  }

  console.log("\n-- readTelegramSettings parse values --");
  {
    const initPath = join(tmp, "init.toml");
    writeFileSync(
      initPath,
      [
        "[settings.telegram]",
        "enabled = true",
        "mode = \"webhook\"",
        "bot_token_env = \"TG_BOT\"",
        "poll_timeout_seconds = 45",
        "rpc_prompt_timeout_seconds = 55",
        "background_prompt_timeout_seconds = 600",
        "allowed_chat_ids = [123, 456]",
        "allowed_user_ids = [42]",
        "require_mention_in_groups = false",
      ].join("\n")
    );

    const settings = readTelegramSettings(initPath);
    assert(settings.enabled === true, "enabled parsed");
    assert(settings.mode === "webhook", "mode parsed");
    assert(settings.botTokenEnv === "TG_BOT", "token env parsed");
    assert(settings.pollTimeoutSeconds === 45, "poll timeout parsed");
    assert(settings.rpcPromptTimeoutSeconds === 55, "rpc prompt timeout parsed");
    assert(settings.backgroundPromptTimeoutSeconds === 600, "background prompt timeout parsed");
    assert(settings.allowedChatIds.length === 2, "chat ids parsed");
    assert(settings.allowedUserIds.length === 1, "user ids parsed");
    assert(settings.requireMentionInGroups === false, "group mention flag parsed");
  }

  console.log("\n-- runtime state read/write --");
  {
    const statePath = join(tmp, "telegram", "state.json");
    const state = loadRuntimeState(statePath);
    assert(existsSync(statePath), "state file created");
    assert(state.last_update_id === 0, "default last_update_id");
    assert(state.mode === "polling", "default mode polling");

    saveRuntimeState({ ...state, last_update_id: 10, consecutive_failures: 1 }, statePath);
    const saved = JSON.parse(readFileSync(statePath, "utf-8")) as any;
    assert(saved.last_update_id === 10, "state write persisted");
    assert(saved.consecutive_failures === 1, "state failure counter persisted");
  }

  console.log("\n-- loadRuntimeState parse existing --");
  {
    const statePath = join(tmp, "telegram", "state.json");
    writeFileSync(
      statePath,
      JSON.stringify({
        last_update_id: 99,
        last_poll_at: "2026-02-13T00:00:00.000Z",
        consecutive_failures: 2,
        mode: "webhook",
      })
    );
    const state = loadRuntimeState(statePath);
    assert(state.last_update_id === 99, "existing last_update_id parsed");
    assert(state.last_poll_at === "2026-02-13T00:00:00.000Z", "existing last_poll_at parsed");
    assert(state.consecutive_failures === 2, "existing consecutive_failures parsed");
    assert(state.mode === "webhook", "existing mode parsed");
  }

  console.log("\n-- advanceUpdateOffset --");
  {
    assert(advanceUpdateOffset(0, []) === 0, "empty updates keep current offset");
    assert(advanceUpdateOffset(10, [5, 7]) === 10, "older updates do not move offset backward");
    assert(advanceUpdateOffset(10, [10, 11]) === 12, "offset advances to max+1");
    assert(advanceUpdateOffset(0, [1, 3, 2]) === 4, "out-of-order ids use max+1");
  }

  console.log("\n-- grammY Api mocked calls + download helper --");
  {
    const originalFetch = globalThis.fetch;
    const calls: Array<{ url: string; init: any }> = [];
    try {
      globalThis.fetch = (async (url: string, init?: any) => {
        const requestUrl = String(url);
        calls.push({ url: requestUrl, init });

        if (requestUrl.endsWith("/getUpdates")) {
          return {
            ok: true,
            status: 200,
            async json() {
              return {
                ok: true,
                result: [{ update_id: 1 }, { update_id: 2 }],
              };
            },
          } as any;
        }

        if (requestUrl.endsWith("/sendMessage")) {
          return {
            ok: false,
            status: 429,
            async json() {
              return {
                ok: false,
                error_code: 429,
                description: "Too Many Requests",
                parameters: { retry_after: 2 },
              };
            },
          } as any;
        }

        if (requestUrl.endsWith("/file/bottest-token/voice/path.oga")) {
          return {
            ok: true,
            status: 200,
            async arrayBuffer() {
              return new Uint8Array([1, 2, 3]).buffer;
            },
          } as any;
        }

        return {
          ok: true,
          status: 200,
          async json() {
            return {
              ok: true,
              result: true,
            };
          },
        } as any;
      }) as any;

      const api = new Api("test-token", {
        apiRoot: "https://example.test",
        fetch: globalThis.fetch as any,
      });

      const updates = await api.getUpdates({ offset: 0, timeout: 1 });
      assert(updates.length === 2, "grammy getUpdates returns mocked updates");

      let gotRateLimit = false;
      try {
        await api.sendMessage(1, "hi");
      } catch (error) {
        gotRateLimit = error instanceof GrammyError && error.parameters?.retry_after === 2;
      }
      assert(gotRateLimit, "grammy sendMessage surfaces retry_after on 429");

      const bytes = await downloadFile("test-token", "voice/path.oga", "https://example.test/");
      assert(bytes.length === 3 && bytes[0] === 1 && bytes[2] === 3, "downloadFile helper returns binary bytes");

      const updatesCall = calls.find((call) => call.url.endsWith("/getUpdates"));
      assert(updatesCall?.url === "https://example.test/bottest-token/getUpdates", "grammy getUpdates targets bot API endpoint");

      const sendMessageCall = calls.find((call) => call.url.endsWith("/sendMessage"));
      assert(sendMessageCall?.url === "https://example.test/bottest-token/sendMessage", "grammy sendMessage targets bot API endpoint");

      const downloadCall = calls.find((call) => call.url.endsWith("/file/bottest-token/voice/path.oga"));
      assert(!!downloadCall, "downloadFile helper targets Telegram file endpoint");
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  console.log("\n-- normalize + authz gates --");
  {
    const update = {
      update_id: 123,
      message: {
        message_id: 9,
        from: { id: 42 },
        chat: { id: 777, type: "private" as const },
        date: 1,
        text: "hello",
      },
    };

    const normalized = normalizeInboundUpdate(update);
    assert(normalized !== null, "normalizes message update");
    assert(normalized?.chatId === 777, "normalized chat id");
    assert(normalized?.userId === 42, "normalized user id");
    assert(normalized?.media === undefined, "text-only messages do not include media envelope");
    assert(normalized?.date === 1, "normalized envelope includes message date");

    const noDatedNormalized = normalizeInboundUpdate({
      update_id: 124,
      message: {
        message_id: 10,
        from: { id: 42 },
        chat: { id: 777, type: "private" as const },
        text: "no date field",
      },
    } as any);
    assert(noDatedNormalized?.date === 0, "missing message date defaults to 0");

    const voiceNormalized = normalizeInboundUpdate({
      update_id: 1231,
      message: {
        message_id: 11,
        from: { id: 42 },
        chat: { id: 777, type: "private" as const },
        date: 1,
        voice: {
          file_id: "voice-file-1",
          duration: 7,
          mime_type: "audio/ogg",
          file_size: 1234,
        },
      },
    });

    assert(voiceNormalized !== null, "normalizes voice-only update without text");
    assert(voiceNormalized?.text === "", "voice-only update keeps empty text payload");
    assert(voiceNormalized?.media?.kind === "voice", "voice envelope marks media kind");
    assert(voiceNormalized?.media?.fileId === "voice-file-1", "voice envelope captures file id");

    const audioNormalized = normalizeInboundUpdate({
      update_id: 1232,
      message: {
        message_id: 12,
        from: { id: 42 },
        chat: { id: 777, type: "private" as const },
        date: 1,
        audio: {
          file_id: "audio-file-1",
          duration: 11,
          mime_type: "audio/mpeg",
          file_name: "sample.mp3",
        },
      },
    });

    assert(audioNormalized !== null, "normalizes audio-only update without text");
    assert(audioNormalized?.media?.kind === "audio", "audio envelope marks media kind");
    assert(audioNormalized?.media?.fileName === "sample.mp3", "audio envelope captures file name");

    const documentAudioNormalized = normalizeInboundUpdate({
      update_id: 1233,
      message: {
        message_id: 13,
        from: { id: 42 },
        chat: { id: 777, type: "private" as const },
        date: 1,
        document: {
          file_id: "doc-audio-1",
          file_name: "note.ogg",
          mime_type: "audio/ogg",
        },
      },
    });

    assert(documentAudioNormalized !== null, "normalizes audio document update without text");
    assert(documentAudioNormalized?.media?.kind === "document_audio", "audio documents are tagged as document_audio media");

    const nonAudioDocument = normalizeInboundUpdate({
      update_id: 1234,
      message: {
        message_id: 14,
        from: { id: 42 },
        chat: { id: 777, type: "private" as const },
        date: 1,
        document: {
          file_id: "doc-non-audio-1",
          file_name: "notes.txt",
          mime_type: "text/plain",
        },
      },
    });

    assert(nonAudioDocument === null, "non-audio documents without text are ignored");

    const settings: TelegramSettings = {
      ...DEFAULT_SETTINGS,
      enabled: true,
      allowedChatIds: [777],
      allowedUserIds: [42],
      requireMentionInGroups: true,
    };

    const authOk = authorizeInbound(normalized!, settings);
    assert(authOk.ok === true, "allowlisted private message authorized");

    const blockedChat = authorizeInbound(normalized!, { ...settings, allowedChatIds: [1] });
    assert(blockedChat.ok === false && blockedChat.reason === "chat_not_allowed", "blocks unknown chat");

    const blockedUser = authorizeInbound(normalized!, { ...settings, allowedUserIds: [99] });
    assert(blockedUser.ok === false && blockedUser.reason === "user_not_allowed", "blocks unknown user");

    const groupEnvelope = normalizeInboundUpdate({
      update_id: 124,
      message: {
        message_id: 10,
        from: { id: 42 },
        chat: { id: -100, type: "group" },
        date: 1,
        text: "random group message",
      },
    });

    const blockedGroup = authorizeInbound(groupEnvelope!, { ...settings, allowedChatIds: [-100] });
    assert(blockedGroup.ok === false && blockedGroup.reason === "group_not_activated", "blocks non-activated group message");

    const activatedGroup = authorizeInbound(
      { ...groupEnvelope!, text: "@rho-bot hi" },
      { ...settings, allowedChatIds: [-100] },
      "rho-bot",
    );
    assert(activatedGroup.ok === true, "allows mentioned group message");
  }

  console.log("\n-- deterministic session mapping --");
  {
    const mapPath = join(tmp, "telegram", "session-map.json");
    const sessionDir = join(tmp, "sessions");
    const dmEnvelope = {
      updateId: 1,
      chatId: 555,
      chatType: "private" as const,
      userId: 42,
      messageId: 10,
      date: 1,
      text: "hello",
      isReplyToBot: false,
    };

    assert(sessionKeyForEnvelope(dmEnvelope) === "dm:555", "dm key format");
    const first = resolveSessionFile(dmEnvelope, mapPath, sessionDir);
    const second = resolveSessionFile(dmEnvelope, mapPath, sessionDir);

    assert(first.created === true, "first mapping creates session file");
    assert(second.created === false, "second mapping reuses session file");
    assert(first.sessionFile === second.sessionFile, "same DM maps to same session file");

    const map = loadSessionMap(mapPath);
    assert(map["dm:555"] === first.sessionFile, "session map persisted for DM");

    const groupEnvelope = { ...dmEnvelope, chatId: -1001, chatType: "group" as const };
    assert(sessionKeyForEnvelope(groupEnvelope) === "group:-1001", "group key format");
    const groupMapping = resolveSessionFile(groupEnvelope, mapPath, sessionDir);
    assert(groupMapping.sessionKey === "group:-1001", "group mapping key stored");
    assert(groupMapping.sessionFile !== first.sessionFile, "group uses different session file");
  }

  console.log("\n-- RPC prompt runner integration (mocked stream) --");
  {
    const fakeSpawn = (() => {
      return (_cmd: string, _args: string[]) => {
        const child = new EventEmitter() as any;
        const stdout = new PassThrough();
        const stderr = new PassThrough();
        const stdin: any = {
          destroyed: false,
          writable: true,
          write: (line: string) => {
            const payload = JSON.parse(String(line).trim());
            if (payload.type === "prompt") {
              setTimeout(() => {
                stdout.write(
                  JSON.stringify({
                    type: "message_end",
                    message: {
                      role: "assistant",
                      content: [{ type: "text", text: "ok from rpc" }],
                    },
                  }) + "\n"
                );
                stdout.write(JSON.stringify({ type: "agent_end" }) + "\n");
              }, 5);
            }
            return true;
          },
        };

        child.stdin = stdin;
        child.stdout = stdout;
        child.stderr = stderr;
        child.kill = () => {
          child.emit("exit", 0, null);
          return true;
        };
        return child;
      };
    })();

    const runner = new TelegramRpcRunner(fakeSpawn as any);
    const response = await runner.runPrompt("/tmp/fake-session.jsonl", "hello", 2000);
    assert(response === "ok from rpc", "RPC runner returns assistant text from message_end");
    runner.dispose();
  }

  console.log("\n-- RPC slash prompt response semantics --");
  {
    const slashSuccessSpawn = ((_cmd: string, _args: string[]) => {
      const child = new EventEmitter() as any;
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const stdin: any = {
        destroyed: false,
        writable: true,
        write: (line: string) => {
          const payload = JSON.parse(String(line).trim());
          if (payload.type === "get_commands") {
            setTimeout(() => {
              stdout.write(JSON.stringify({
                type: "response",
                id: payload.id,
                command: "get_commands",
                success: true,
                data: { commands: [{ name: "telegram", source: "extension" }] },
              }) + "\n");
            }, 5);
            return true;
          }

          if (payload.type === "prompt") {
            setTimeout(() => {
              stdout.write(JSON.stringify({
                type: "response",
                id: payload.id,
                command: "prompt",
                success: true,
              }) + "\n");
              stdout.write(JSON.stringify({ type: "agent_end" }) + "\n");
            }, 5);
          }
          return true;
        },
      };
      child.stdin = stdin;
      child.stdout = stdout;
      child.stderr = stderr;
      child.kill = () => {
        child.emit("exit", 0, null);
        return true;
      };
      return child;
    }) as any;

    const slashSuccessRunner = new TelegramRpcRunner(slashSuccessSpawn);
    const slashAck = await slashSuccessRunner.runPrompt("/tmp/fake-slash-session.jsonl", "/telegram status", 250);
    assert(slashAck.includes("/telegram"), "slash prompt resolves after agent_end with deterministic acknowledgement");
    slashSuccessRunner.dispose();

    const slashInventoryUnavailableSpawn = ((_cmd: string, _args: string[]) => {
      const child = new EventEmitter() as any;
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const stdin: any = {
        destroyed: false,
        writable: true,
        write: (_line: string) => true,
      };
      child.stdin = stdin;
      child.stdout = stdout;
      child.stderr = stderr;
      child.kill = () => {
        child.emit("exit", 0, null);
        return true;
      };
      return child;
    }) as any;

    const slashInventoryUnavailableRunner = new TelegramRpcRunner(slashInventoryUnavailableSpawn);
    let slashInventoryUnavailableRejected = false;
    try {
      await slashInventoryUnavailableRunner.runPrompt("/tmp/fake-slash-inventory-unavailable-session.jsonl", "/telegram status", 250);
    } catch (error) {
      slashInventoryUnavailableRejected = String((error as Error)?.message || "")
        .includes("Slash command inventory unavailable");
    }
    assert(slashInventoryUnavailableRejected, "slash prompt fails closed when command inventory cannot be loaded");
    slashInventoryUnavailableRunner.dispose();

    const slashAgentStartOnlySpawn = ((_cmd: string, _args: string[]) => {
      const child = new EventEmitter() as any;
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const stdin: any = {
        destroyed: false,
        writable: true,
        write: (line: string) => {
          const payload = JSON.parse(String(line).trim());
          if (payload.type === "get_commands") {
            setTimeout(() => {
              stdout.write(JSON.stringify({
                type: "response",
                id: payload.id,
                command: "get_commands",
                success: true,
                data: { commands: [{ name: "telegram", source: "extension" }] },
              }) + "\n");
            }, 5);
            return true;
          }

          if (payload.type === "prompt") {
            setTimeout(() => {
              stdout.write(JSON.stringify({
                type: "response",
                id: payload.id,
                command: "prompt",
                success: true,
              }) + "\n");
              stdout.write(JSON.stringify({ type: "agent_start" }) + "\n");
            }, 5);
          }
          return true;
        },
      };
      child.stdin = stdin;
      child.stdout = stdout;
      child.stderr = stderr;
      child.kill = () => {
        child.emit("exit", 0, null);
        return true;
      };
      return child;
    }) as any;

    const slashAgentStartOnlyRunner = new TelegramRpcRunner(slashAgentStartOnlySpawn);
    const slashAgentStartOnlyBegin = Date.now();
    let slashAgentStartOnlyTimedOut = false;
    try {
      await slashAgentStartOnlyRunner.runPrompt("/tmp/fake-slash-start-only-session.jsonl", "/telegram check", 900);
    } catch (error) {
      slashAgentStartOnlyTimedOut = String((error as Error)?.message || "").includes("timed out");
    }
    const slashAgentStartOnlyElapsed = Date.now() - slashAgentStartOnlyBegin;
    assert(slashAgentStartOnlyTimedOut, "slash prompt times out when prompt response never reaches message_end/agent_end");
    assert(slashAgentStartOnlyElapsed >= 800, "slash prompt waits near full timeout when completion events are missing");
    slashAgentStartOnlyRunner.dispose();

    const slashMessageWithoutAgentEndSpawn = ((_cmd: string, _args: string[]) => {
      const child = new EventEmitter() as any;
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const stdin: any = {
        destroyed: false,
        writable: true,
        write: (line: string) => {
          const payload = JSON.parse(String(line).trim());
          if (payload.type === "get_commands") {
            setTimeout(() => {
              stdout.write(JSON.stringify({
                type: "response",
                id: payload.id,
                command: "get_commands",
                success: true,
                data: { commands: [{ name: "telegram", source: "extension" }] },
              }) + "\n");
            }, 5);
            return true;
          }

          if (payload.type === "prompt") {
            setTimeout(() => {
              stdout.write(JSON.stringify({
                type: "response",
                id: payload.id,
                command: "prompt",
                success: true,
              }) + "\n");
              stdout.write(JSON.stringify({ type: "agent_start" }) + "\n");
              stdout.write(JSON.stringify({
                type: "message_end",
                message: {
                  role: "assistant",
                  content: [{ type: "text", text: "slash response without agent_end" }],
                },
              }) + "\n");
            }, 5);
          }
          return true;
        },
      };
      child.stdin = stdin;
      child.stdout = stdout;
      child.stderr = stderr;
      child.kill = () => {
        child.emit("exit", 0, null);
        return true;
      };
      return child;
    }) as any;

    const slashMessageWithoutAgentEndRunner = new TelegramRpcRunner(slashMessageWithoutAgentEndSpawn);
    const slashMessageWithoutAgentEndBegin = Date.now();
    const slashMessageWithoutAgentEndResult = await slashMessageWithoutAgentEndRunner.runPrompt("/tmp/fake-slash-message-no-end-session.jsonl", "/telegram status", 900);
    const slashMessageWithoutAgentEndElapsed = Date.now() - slashMessageWithoutAgentEndBegin;
    assert(slashMessageWithoutAgentEndResult === "slash response without agent_end", "slash prompt returns assistant text even when agent_end is missing");
    assert(slashMessageWithoutAgentEndElapsed < 600, "slash prompt returns assistant text without waiting for full timeout when agent_end is missing");
    slashMessageWithoutAgentEndRunner.dispose();

    const slashUnsupportedSpawn = ((_cmd: string, _args: string[]) => {
      const child = new EventEmitter() as any;
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const stdin: any = {
        destroyed: false,
        writable: true,
        write: (line: string) => {
          const payload = JSON.parse(String(line).trim());
          if (payload.type === "get_commands") {
            setTimeout(() => {
              stdout.write(JSON.stringify({
                type: "response",
                id: payload.id,
                command: "get_commands",
                success: true,
                data: { commands: [{ name: "telegram", source: "extension" }] },
              }) + "\n");
            }, 5);
            return true;
          }
          if (payload.type === "prompt") {
            setTimeout(() => {
              stdout.write(JSON.stringify({
                type: "response",
                id: payload.id,
                command: "prompt",
                success: false,
                error: "Unknown command: /telegram",
              }) + "\n");
            }, 5);
          }
          return true;
        },
      };
      child.stdin = stdin;
      child.stdout = stdout;
      child.stderr = stderr;
      child.kill = () => {
        child.emit("exit", 0, null);
        return true;
      };
      return child;
    }) as any;

    const slashUnsupportedRunner = new TelegramRpcRunner(slashUnsupportedSpawn);
    let slashUnsupportedMapped = false;
    try {
      await slashUnsupportedRunner.runPrompt("/tmp/fake-slash-unsupported-session.jsonl", "/telegram nope", 250);
    } catch (error) {
      slashUnsupportedMapped = String((error as Error)?.message || "").includes("Unsupported slash command /telegram");
    }
    assert(slashUnsupportedMapped, "maps unknown slash command RPC errors to actionable text");
    slashUnsupportedRunner.dispose();

    let spawnCount = 0;
    const mixedPromptSpawn = ((_cmd: string, _args: string[]) => {
      spawnCount += 1;
      const child = new EventEmitter() as any;
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const stdin: any = {
        destroyed: false,
        writable: true,
        write: (line: string) => {
          const payload = JSON.parse(String(line).trim());

          if (payload.type === "get_commands") {
            setTimeout(() => {
              stdout.write(JSON.stringify({
                type: "response",
                id: payload.id,
                command: "get_commands",
                success: true,
                data: { commands: [{ name: "telegram", source: "extension" }] },
              }) + "\n");
            }, 5);
            return true;
          }

          if (payload.type !== "prompt") return true;

          if (typeof payload.message === "string" && payload.message.startsWith("/")) {
            setTimeout(() => {
              stdout.write(JSON.stringify({
                type: "response",
                id: payload.id,
                command: "prompt",
                success: true,
              }) + "\n");
              stdout.write(JSON.stringify({ type: "agent_end" }) + "\n");
            }, 5);
            return true;
          }

          setTimeout(() => {
            stdout.write(JSON.stringify({
              type: "response",
              id: payload.id,
              command: "prompt",
              success: true,
            }) + "\n");
            stdout.write(JSON.stringify({
              type: "message_end",
              message: { role: "assistant", content: [{ type: "text", text: "normal prompt ok" }] },
            }) + "\n");
            stdout.write(JSON.stringify({ type: "agent_end" }) + "\n");
          }, 5);
          return true;
        },
      };
      child.stdin = stdin;
      child.stdout = stdout;
      child.stderr = stderr;
      child.kill = () => {
        child.emit("exit", 0, null);
        return true;
      };
      return child;
    }) as any;

    const mixedRunner = new TelegramRpcRunner(mixedPromptSpawn);
    const first = await mixedRunner.runPrompt("/tmp/fake-mixed-session.jsonl", "/telegram check", 300);
    const second = await mixedRunner.runPrompt("/tmp/fake-mixed-session.jsonl", "regular prompt", 2000);
    assert(first.includes("/telegram"), "mixed prompt flow: slash result returns deterministic acknowledgement text");
    assert(second === "normal prompt ok", "mixed prompt flow: non-slash prompt still resolves via assistant output");
    assert(spawnCount === 1, "mixed prompt flow reuses the same RPC session for slash + non-slash prompts");
    mixedRunner.dispose();
  }

  console.log("\n-- RPC busy prompts retry with followUp queue semantics --");
  {
    const promptPayloads: any[] = [];
    const busyRetrySpawn = ((_cmd: string, _args: string[]) => {
      const child = new EventEmitter() as any;
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const stdin: any = {
        destroyed: false,
        writable: true,
        write: (line: string) => {
          const payload = JSON.parse(String(line).trim());
          if (payload.type !== "prompt") return true;

          promptPayloads.push(payload);
          setTimeout(() => {
            if (!payload.streamingBehavior) {
              stdout.write(JSON.stringify({
                type: "response",
                id: payload.id,
                command: "prompt",
                success: false,
                error: "Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.",
              }) + "\n");
              return;
            }

            stdout.write(JSON.stringify({
              type: "response",
              id: payload.id,
              command: "prompt",
              success: true,
            }) + "\n");
            stdout.write(JSON.stringify({
              type: "message_end",
              message: { role: "assistant", content: [{ type: "text", text: "queued ok" }] },
            }) + "\n");
            stdout.write(JSON.stringify({ type: "agent_end" }) + "\n");
          }, 5);

          return true;
        },
      };
      child.stdin = stdin;
      child.stdout = stdout;
      child.stderr = stderr;
      child.kill = () => {
        child.emit("exit", 0, null);
        return true;
      };
      return child;
    }) as any;

    const busyRetryRunner = new TelegramRpcRunner(busyRetrySpawn);
    const queuedResponse = await busyRetryRunner.runPrompt("/tmp/fake-busy-retry-session.jsonl", "long running request", 2000);

    assert(queuedResponse === "queued ok", "busy prompt retry returns assistant output after followUp queue");
    assert(promptPayloads.length === 2, "busy prompt retry sends initial prompt then one queued followUp retry");
    assert(!("streamingBehavior" in promptPayloads[0]), "first busy prompt attempt sends immediate prompt semantics");
    assert(promptPayloads[1]?.streamingBehavior === "followUp", "second busy prompt attempt sets streamingBehavior=followUp");

    busyRetryRunner.dispose();
  }

  console.log("\n-- RPC slash inventory classification --");
  {
    let promptCount = 0;
    const inventorySpawn = ((_cmd: string, _args: string[]) => {
      const child = new EventEmitter() as any;
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const stdin: any = {
        destroyed: false,
        writable: true,
        write: (line: string) => {
          const payload = JSON.parse(String(line).trim());

          if (payload.type === "get_commands") {
            setTimeout(() => {
              stdout.write(JSON.stringify({
                type: "response",
                id: payload.id,
                command: "get_commands",
                success: true,
                data: {
                  commands: [
                    { name: "telegram", source: "extension" },
                    { name: "skill:triage", source: "skill" },
                  ],
                },
              }) + "\n");
            }, 5);
            return true;
          }

          if (payload.type === "prompt") {
            promptCount += 1;
            setTimeout(() => {
              stdout.write(JSON.stringify({
                type: "response",
                id: payload.id,
                command: "prompt",
                success: true,
              }) + "\n");
              stdout.write(JSON.stringify({ type: "agent_end" }) + "\n");
            }, 5);
          }

          return true;
        },
      };
      child.stdin = stdin;
      child.stdout = stdout;
      child.stderr = stderr;
      child.kill = () => {
        child.emit("exit", 0, null);
        return true;
      };
      return child;
    }) as any;

    const runner = new TelegramRpcRunner(inventorySpawn);

    const supported = await runner.runPrompt("/tmp/fake-inventory-session.jsonl", "/telegram status", 300);
    assert(supported.includes("/telegram"), "supported slash command runs via prompt with deterministic ack");

    const mentionQualified = await runner.runPrompt("/tmp/fake-inventory-session.jsonl", "/telegram@tau_rhobot status", 300);
    assert(mentionQualified.includes("/telegram status"), "mention-qualified slash command normalizes to canonical command");

    let interactiveRejected = false;
    try {
      await runner.runPrompt("/tmp/fake-inventory-session.jsonl", "/settings", 300);
    } catch (error) {
      interactiveRejected = String((error as Error)?.message || "").includes("interactive TUI");
    }
    assert(interactiveRejected, "interactive-only slash command is rejected before prompt execution");
    assert(promptCount === 2, "interactive-only slash rejection does not send prompt RPC command");

    let uiNotifiedSlashResult: string | null = null;
    const uiNotifyRunner = new TelegramRpcRunner((_cmd: string, _args: string[]) => {
      const child = new EventEmitter() as any;
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const stdin: any = {
        destroyed: false,
        writable: true,
        write: (line: string) => {
          const payload = JSON.parse(String(line).trim());

          if (payload.type === "get_commands") {
            setTimeout(() => {
              stdout.write(JSON.stringify({
                type: "response",
                id: payload.id,
                command: "get_commands",
                success: true,
                data: {
                  commands: [
                    { name: "telegram", source: "extension" },
                  ],
                },
              }) + "\n");
            }, 5);
            return true;
          }

          if (payload.type === "prompt") {
            setTimeout(() => {
              stdout.write(JSON.stringify({
                type: "response",
                id: payload.id,
                command: "prompt",
                success: true,
              }) + "\n");
              stdout.write(JSON.stringify({
                type: "extension_ui_request",
                request: {
                  method: "notify",
                  message: "/telegram status executed via extension ui notify",
                  level: "info",
                },
              }) + "\n");
            }, 5);
          }
          return true;
        },
      };
      child.stdin = stdin;
      child.stdout = stdout;
      child.stderr = stderr;
      child.kill = () => {
        child.emit("exit", 0, null);
        return true;
      };
      return child;
    }) as any;

    uiNotifiedSlashResult = await uiNotifyRunner.runPrompt("/tmp/fake-inventory-notify-session.jsonl", "/telegram status", 300);
    assert(
      uiNotifiedSlashResult === "/telegram status executed via extension ui notify",
      "extension ui notify events are surfaced as slash command output",
    );

    uiNotifyRunner.dispose();
    runner.dispose();
  }

  console.log("\n-- RPC stderr handling (warnings vs fatal) --");
  {
    const warningSpawn = ((_cmd: string, _args: string[]) => {
      const child = new EventEmitter() as any;
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const stdin: any = {
        destroyed: false,
        writable: true,
        write: (line: string) => {
          const payload = JSON.parse(String(line).trim());
          if (payload.type === "prompt") {
            setTimeout(() => {
              stderr.write("(node:123) ExperimentalWarning: SQLite is an experimental feature and might change at any time\n");
              stderr.write("(Use `node --trace-warnings ...` to show where the warning was created)\n");
              stdout.write(
                JSON.stringify({
                  type: "message_end",
                  message: { role: "assistant", content: [{ type: "text", text: "warning ignored" }] },
                }) + "\n"
              );
              stdout.write(JSON.stringify({ type: "agent_end" }) + "\n");
            }, 5);
          }
          return true;
        },
      };
      child.stdin = stdin;
      child.stdout = stdout;
      child.stderr = stderr;
      child.kill = () => {
        child.emit("exit", 0, null);
        return true;
      };
      return child;
    }) as any;

    const warningRunner = new TelegramRpcRunner(warningSpawn);
    const warningResponse = await warningRunner.runPrompt("/tmp/fake-warning-session.jsonl", "hello", 2000);
    assert(warningResponse === "warning ignored", "ignores known non-fatal sqlite warning stderr");
    warningRunner.dispose();

    const fatalSpawn = ((_cmd: string, _args: string[]) => {
      const child = new EventEmitter() as any;
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const stdin: any = {
        destroyed: false,
        writable: true,
        write: (line: string) => {
          const payload = JSON.parse(String(line).trim());
          if (payload.type === "prompt") {
            setTimeout(() => {
              stderr.write("Fatal RPC crash\n");
            }, 5);
          }
          return true;
        },
      };
      child.stdin = stdin;
      child.stdout = stdout;
      child.stderr = stderr;
      child.kill = () => {
        child.emit("exit", 0, null);
        return true;
      };
      return child;
    }) as any;

    const fatalRunner = new TelegramRpcRunner(fatalSpawn);
    let fatalRejected = false;
    try {
      await fatalRunner.runPrompt("/tmp/fake-fatal-session.jsonl", "hello", 2000);
    } catch (error) {
      fatalRejected = String((error as Error)?.message || "").includes("RPC stderr");
    }
    assert(fatalRejected, "rejects on non-ignorable stderr");
    fatalRunner.dispose();
  }

  console.log("\n-- RPC child env isolation --");
  {
    let capturedEnv: Record<string, string> | undefined;
    const capturingSpawn = ((_cmd: string, _args: string[], opts?: any) => {
      capturedEnv = opts?.env as Record<string, string> | undefined;

      const child = new EventEmitter() as any;
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const stdin: any = {
        destroyed: false,
        writable: true,
        write: (line: string) => {
          const payload = JSON.parse(String(line).trim());
          if (payload.type === "prompt") {
            setTimeout(() => {
              stdout.write(
                JSON.stringify({
                  type: "message_end",
                  message: { role: "assistant", content: [{ type: "text", text: "env ok" }] },
                }) + "\n"
              );
              stdout.write(JSON.stringify({ type: "agent_end" }) + "\n");
            }, 5);
          }
          return true;
        },
      };
      child.stdin = stdin;
      child.stdout = stdout;
      child.stderr = stderr;
      child.kill = () => {
        child.emit("exit", 0, null);
        return true;
      };
      return child;
    }) as any;

    const runner = new TelegramRpcRunner(capturingSpawn);
    const response = await runner.runPrompt("/tmp/fake-env-session.jsonl", "hello", 2000);
    assert(response === "env ok", "rpc still works with env isolation");
    assert(capturedEnv?.RHO_TELEGRAM_DISABLE === "1", "RPC child disables telegram polling without disabling other extensions");
    assert(capturedEnv?.RHO_SUBAGENT !== "1", "RPC child does not force global subagent mode");
    runner.dispose();
  }

  console.log("\n-- rpc module loads with strip-types --");
  {
    const rpcPath = join(process.cwd(), "extensions", "telegram", "rpc.ts");
    const result = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", rpcPath], {
      encoding: "utf-8",
    });
    assert(result.status === 0, "rpc module loads under experimental strip-types");
  }

  console.log("\n-- outbound rendering + chunking --");
  {
    assert(renderOutboundText("   hi  ") === "hi", "render trims surrounding whitespace");
    assert(renderOutboundText("   ") === "(empty response)", "render fallback for empty output");

    const short = chunkTelegramText("hello", 10);
    assert(short.length === 1 && short[0] === "hello", "short messages stay single chunk");

    const longText = "a".repeat(9500);
    const chunks = chunkTelegramText(longText, 4096);
    assert(chunks.length === 3, "long message split into expected chunk count");
    assert(chunks.every((c) => c.length <= 4096), "all chunks respect max length");
    assert(chunks.join("") === longText, "chunks preserve message content when rejoined");

    const markdown = [
      "# Heading",
      "",
      "Use **bold** and `code`.",
      "",
      "```",
      "const x = 1 < 2 && 3 > 2;",
      "```",
      "",
      "Link: [rho](https://rhobot.dev)",
    ].join("\n");

    const rendered = renderTelegramOutboundChunks(markdown, 4096);
    assert(rendered.length >= 1, "markdown render produces outbound chunks");
    assert(rendered[0].parseMode === "HTML", "markdown chunks use HTML parse mode");
    assert(rendered.some((c) => c.text.includes("<b>Heading</b>")), "heading renders as bold html");
    assert(rendered.some((c) => c.text.includes("<code>code</code>")), "inline code renders as code html");
    assert(rendered.some((c) => c.text.includes("<pre><code>")), "fenced code renders as pre/code html");
    assert(rendered.some((c) => c.text.includes('<a href="https://rhobot.dev">rho</a>')), "markdown links render as html links");
    assert(rendered.every((c) => c.text.length <= 4096), "rendered markdown chunks fit Telegram limit");
  }

  console.log("\n-- parse-mode error detection --");
  {
    const parseError = createGrammyApiError("Bad Request: can't parse entities", 400);
    const serverError = createGrammyApiError("Internal Server Error", 500);

    assert(isTelegramParseModeError(parseError) === true, "detects parse-mode entity errors");
    assert(isTelegramParseModeError(serverError) === false, "does not treat 5xx as parse-mode errors");
    assert(isTelegramParseModeError(new Error("nope")) === false, "non-telegram errors are ignored");
  }

  console.log("\n-- retry policy helpers --");
  {
    const e429 = createGrammyApiError("rate", 429, 2);
    assert(isRetryableAfterAutoRetry(e429, 0) === true, "retry 429 on first attempt");
    assert(queueRetryDelayMs(e429, 0) === 2000, "retry_after overrides delay");

    const e500 = createGrammyApiError("server", 500);
    assert(isRetryableAfterAutoRetry(e500, 1) === true, "retry 5xx errors");
    assert(queueRetryDelayMs(e500, 2) === 8000, "backoff for non-retry_after error");

    const e400 = createGrammyApiError("bad", 400);
    assert(isRetryableAfterAutoRetry(e400, 0) === false, "do not retry 4xx non-rate-limit");
    assert(isRetryableAfterAutoRetry(e500, 6) === false, "respect max attempt cap");

    const transport = new HttpError("network down", new Error("ECONNRESET"));
    assert(isRetryableAfterAutoRetry(transport, 1) === true, "transport failures remain retryable");
  }

  console.log("\n-- slash acknowledgement formatting --");
  {
    assert(
      formatSlashAcknowledgement("/telegram status") === "✅ /telegram status executed.",
      "slash acknowledgement includes command + first argument context",
    );
    assert(
      formatSlashAcknowledgement("/telegram") === "✅ /telegram executed.",
      "slash acknowledgement falls back to command-only when no args are provided",
    );
  }

  console.log("\n-- log event normalization --");
  {
    const logPath = join(tmp, "telegram", "events.jsonl");

    appendTelegramLog({ type: "legacy_type_event", foo: 1 }, logPath);
    appendTelegramLog({ event: "modern_event", bar: 2 }, logPath);

    const lines = readFileSync(logPath, "utf-8").trim().split("\n").map((l) => JSON.parse(l) as any);
    assert(lines.length === 2, "two log lines written");
    assert(lines[0].event === "unknown", "missing event key defaults to unknown");
    assert(lines[0].type === undefined, "legacy type key is not promoted into schema fields");
    assert(lines[1].event === "modern_event", "modern event key preserved");
    assert(lines[0].source === "telegram", "log source is telegram");
    assert(lines[0].schema_version === 1, "log schema version present");
  }

  console.log("\n-- telegram log rotation --");
  {
    const rotatedLogPath = join(tmp, "telegram", "rotate.jsonl");

    const prevMaxBytes = process.env.RHO_TELEGRAM_LOG_MAX_BYTES;
    const prevMaxFiles = process.env.RHO_TELEGRAM_LOG_MAX_FILES;
    process.env.RHO_TELEGRAM_LOG_MAX_BYTES = "220";
    process.env.RHO_TELEGRAM_LOG_MAX_FILES = "3";

    try {
      for (let i = 0; i < 50; i++) {
        appendTelegramLog({ event: "rotation_test", sequence: i }, rotatedLogPath);
      }

      const countLines = (filePath: string): number => {
        if (!existsSync(filePath)) return 0;
        const raw = readFileSync(filePath, "utf-8").trim();
        return raw ? raw.split("\n").filter((line) => line.trim()).length : 0;
      };

      const totalLines = countLines(rotatedLogPath)
        + countLines(`${rotatedLogPath}.1`)
        + countLines(`${rotatedLogPath}.2`)
        + countLines(`${rotatedLogPath}.3`);

      assert(totalLines < 50, "log rotation retains recent entries and prunes old ones");
      assert(existsSync(rotatedLogPath), "active telegram log exists");
      assert(existsSync(`${rotatedLogPath}.1`), "telegram log rotates to .1 archive");
      assert(!existsSync(`${rotatedLogPath}.4`), "telegram log caps archive count by max files");
    } finally {
      if (prevMaxBytes === undefined) {
        delete process.env.RHO_TELEGRAM_LOG_MAX_BYTES;
      } else {
        process.env.RHO_TELEGRAM_LOG_MAX_BYTES = prevMaxBytes;
      }

      if (prevMaxFiles === undefined) {
        delete process.env.RHO_TELEGRAM_LOG_MAX_FILES;
      } else {
        process.env.RHO_TELEGRAM_LOG_MAX_FILES = prevMaxFiles;
      }
    }
  }

  console.log("\n-- operator config persistence --");
  {
    const configPath = join(tmp, "telegram", "operator-config.json");

    assert(loadOperatorConfig(configPath) === null, "missing operator config returns null");

    saveOperatorConfig(
      {
        allowedChatIds: [777, 777, -1000, 12.4 as any] as any,
        allowedUserIds: [42, 42, -7],
      },
      configPath,
    );

    const loaded = loadOperatorConfig(configPath);
    assert(loaded !== null, "saved operator config loads");
    assert(JSON.stringify(loaded?.allowedChatIds) === JSON.stringify([777, -1000]), "chat ids are normalized + deduped");
    assert(JSON.stringify(loaded?.allowedUserIds) === JSON.stringify([42, -7]), "user ids are normalized + deduped");

    writeFileSync(configPath, "{not-json");
    assert(loadOperatorConfig(configPath) === null, "invalid operator config returns null");
  }

  console.log("\n-- poll leadership election + takeover --");
  {
    const lockPath = join(tmp, "telegram", "poll.lock.json");
    const staleMs = 2_000;
    const now = Date.now();

    const contenderA = createTelegramPollLeadershipState();
    const contenderB = createTelegramPollLeadershipState();

    const aInitial = stepTelegramPollLeadership(contenderA, {
      lockPath,
      nonce: "nonce-a",
      now,
      staleMs,
    });
    const bInitial = stepTelegramPollLeadership(contenderB, {
      lockPath,
      nonce: "nonce-b",
      now,
      staleMs,
    });

    assert(aInitial.isLeader !== bInitial.isLeader, "exactly one contender becomes leader");

    const leader = aInitial.isLeader ? contenderA : contenderB;
    const follower = aInitial.isLeader ? contenderB : contenderA;
    const leaderNonce = aInitial.isLeader ? "nonce-a" : "nonce-b";
    const followerNonce = aInitial.isLeader ? "nonce-b" : "nonce-a";

    for (let i = 1; i <= 3; i++) {
      stepTelegramPollLeadership(leader, {
        lockPath,
        nonce: leaderNonce,
        now: now + i * 100,
        staleMs,
      });
      const followerTick = stepTelegramPollLeadership(follower, {
        lockPath,
        nonce: followerNonce,
        now: now + i * 100,
        staleMs,
      });
      assert(followerTick.isLeader === false, "follower remains follower while leader refreshes lease");
    }

    releaseTelegramPollLeadership(leader);
    const handover = stepTelegramPollLeadership(follower, {
      lockPath,
      nonce: followerNonce,
      now: now + 500,
      staleMs,
    });
    assert(handover.isLeader === true && handover.becameLeader === true, "follower takes over after leader release");

    releaseTelegramPollLeadership(follower);

    writeFileSync(
      lockPath,
      JSON.stringify(
        {
          version: 1,
          purpose: "rho-telegram-poll-leadership",
          pid: 999_999,
          nonce: "stale-owner",
          acquiredAt: now - 10_000,
          refreshedAt: now - 10_000,
          hostname: "test-host",
        },
        null,
        2,
      ),
    );

    const staleTakeoverState = createTelegramPollLeadershipState();
    const staleTakeover = stepTelegramPollLeadership(staleTakeoverState, {
      lockPath,
      nonce: "nonce-stale-takeover",
      now: now + staleMs + 10,
      staleMs,
    });
    assert(staleTakeover.isLeader === true, "stale lock is taken over by live contender");

    releaseTelegramPollLeadership(staleTakeoverState);
  }

  console.log("\n-- operator check trigger request/consume --");
  {
    const triggerPath = join(tmp, "telegram", "check.trigger.json");

    const requested = requestTelegramCheckTrigger(triggerPath, {
      requestedAt: Date.now(),
      requesterPid: 2222,
      source: "tool",
      requesterRole: "follower",
    });
    assert(requested === true, "follower check request persists trigger payload");

    const pending = getTelegramCheckTriggerState(triggerPath, 0);
    assert(pending.pending === true, "pending trigger is visible for status surfaces");
    assert(pending.requesterPid === 2222, "pending trigger exposes requester pid");

    const consumed = consumeTelegramCheckTrigger(triggerPath, 0);
    assert(consumed.triggered === true, "leader consumes follower check trigger");
    assert(consumed.request?.requesterPid === 2222, "consumed trigger returns requester metadata");

    const consumedAgain = consumeTelegramCheckTrigger(triggerPath, consumed.nextSeen);
    assert(consumedAgain.triggered === false, "consumed trigger is not replayed without a new request");
  }

  console.log("\n-- operator status rendering includes leadership/trigger health --");
  {
    const status = renderTelegramStatusText({
      enabled: true,
      mode: "polling",
      leadershipText: "follower (leader pid 4321 @host)",
      pollLockPath: "/tmp/poll.lock.json",
      pollLockOwnerText: "4321 @host",
      triggerPath: "/tmp/check.trigger.json",
      triggerPending: true,
      triggerRequesterPid: 2222,
      triggerRequestedAt: 1_700_000_000_000,
      lastCheckRequestAt: 1_700_000_000_100,
      lastCheckConsumeAt: 1_700_000_000_200,
      lastCheckOutcome: "ok",
      lastCheckRequesterPid: 2222,
      tokenEnv: "TELEGRAM_BOT_TOKEN",
      lastUpdateId: 12,
      lastPollAt: "2026-02-13T00:00:00.000Z",
      pollFailures: 0,
      sendFailures: 1,
      pendingInbound: 2,
      pendingOutbound: 3,
      allowedChatsText: "all",
      allowedUsersText: "all",
    });

    assert(status.includes("Leadership: follower (leader pid 4321 @host)"), "status includes leadership role + owner context");
    assert(status.includes("Check trigger pending: yes"), "status includes trigger pending context");
    assert(status.includes("Last check outcome: ok"), "status includes check execution outcome");
    assert(status.includes("Last check requester pid: 2222"), "status includes requester pid for last consumed check");

    const ui = renderTelegramUiStatus({
      mode: "polling",
      isLeader: false,
      ownerPid: 4321,
      lastUpdateId: 12,
      pendingInbound: 2,
      pendingOutbound: 3,
      pollFailures: 1,
      sendFailures: 0,
      triggerPending: true,
    });

    assert(ui.includes("F4321"), "ui status includes follower owner pid context");
    assert(ui.includes("tr!"), "ui status includes trigger pending marker");
    assert(ui.includes("pf1"), "ui status includes poll health context");
  }

  console.log("\n-- cli status surfaces consumed check telemetry --");
  {
    const cliHome = join(tmp, "cli-home");
    const initPath = join(cliHome, ".rho", "init.toml");
    const statePath = join(cliHome, ".rho", "telegram", "state.json");

    mkdirSync(join(cliHome, ".rho", "telegram"), { recursive: true });

    writeFileSync(
      initPath,
      [
        "[settings.telegram]",
        "enabled = true",
        "mode = \"polling\"",
      ].join("\n"),
    );

    writeFileSync(
      statePath,
      JSON.stringify({
        last_update_id: 9,
        last_poll_at: "2026-02-13T00:00:00.000Z",
        consecutive_failures: 0,
        mode: "polling",
        last_check_request_at: 1_700_000_000_100,
        last_check_consume_at: 1_700_000_000_200,
        last_check_outcome: "ok",
        last_check_requester_pid: 7777,
      }),
    );

    const cli = spawnSync("node", ["cli/rho.mjs", "telegram", "status"], {
      cwd: process.cwd(),
      env: { ...process.env, HOME: cliHome },
      encoding: "utf-8",
    });

    assert(cli.status === 0, "cli status exits zero");
    assert(cli.stdout.includes("Last check consume at:"), "cli status includes check consume timestamp line");
    assert(cli.stdout.includes("Last check outcome: ok"), "cli status includes persisted check outcome");
    assert(cli.stdout.includes("Last check requester pid: 7777"), "cli status includes persisted check requester pid");
  }

  console.log("\n-- operator check event logging --");
  {
    const logPath = join(tmp, "telegram", "operator-events.jsonl");
    appendTelegramLog({ event: "operator_check_requested", route: "follower_trigger", requester_pid: 2222 }, logPath);
    appendTelegramLog({ event: "operator_check_trigger_consumed", requester_pid: 2222, consumed_by_pid: 1111 }, logPath);
    appendTelegramLog({ event: "operator_check_executed", executed_by_pid: 1111, result: "ok" }, logPath);

    const events = readFileSync(logPath, "utf-8").trim().split("\n").map((line) => JSON.parse(line) as any);
    assert(events[0].event === "operator_check_requested", "log includes operator_check_requested event");
    assert(events[0].route === "follower_trigger", "check request log preserves route metadata");
    assert(events[1].event === "operator_check_trigger_consumed", "log includes trigger consumed event");
    assert(events[2].event === "operator_check_executed", "log includes check executed event");
    assert(events[2].result === "ok", "check executed log preserves outcome metadata");
  }

  console.log("\n-- mocked end-to-end pipeline --");
  {
    const update = {
      update_id: 501,
      message: {
        message_id: 77,
        from: { id: 42 },
        chat: { id: 777, type: "private" as const },
        date: 1,
        text: "hello from telegram",
      },
    };

    const normalized = normalizeInboundUpdate(update);
    assert(normalized !== null, "pipeline: normalized update");

    const settings: TelegramSettings = {
      ...DEFAULT_SETTINGS,
      enabled: true,
      allowedChatIds: [777],
      allowedUserIds: [42],
      requireMentionInGroups: true,
    };

    const auth = authorizeInbound(normalized!, settings);
    assert(auth.ok === true, "pipeline: auth passes");

    const mapPath = join(tmp, "telegram", "session-map-e2e.json");
    const sessionDir = join(tmp, "sessions-e2e");
    const mapped = resolveSessionFile(normalized!, mapPath, sessionDir);
    assert(mapped.sessionFile.length > 0, "pipeline: session mapped");

    const fakeSpawn = ((_cmd: string, _args: string[]) => {
      const child = new EventEmitter() as any;
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const stdin: any = {
        destroyed: false,
        writable: true,
        write: (line: string) => {
          const payload = JSON.parse(String(line).trim());
          if (payload.type === "prompt") {
            setTimeout(() => {
              stdout.write(
                JSON.stringify({
                  type: "message_end",
                  message: {
                    role: "assistant",
                    content: [{ type: "text", text: "telegram e2e ok" }],
                  },
                }) + "\n"
              );
              stdout.write(JSON.stringify({ type: "agent_end" }) + "\n");
            }, 5);
          }
          return true;
        },
      };
      child.stdin = stdin;
      child.stdout = stdout;
      child.stderr = stderr;
      child.kill = () => {
        child.emit("exit", 0, null);
        return true;
      };
      return child;
    }) as any;

    const runner = new TelegramRpcRunner(fakeSpawn);
    const response = await runner.runPrompt(mapped.sessionFile, normalized!.text, 2000);
    const chunks = chunkTelegramText(response, 4096);

    assert(response === "telegram e2e ok", "pipeline: rpc response captured");
    assert(chunks.length === 1 && chunks[0] === "telegram e2e ok", "pipeline: outbound chunk ready");

    runner.dispose();
  }

  console.log("\n-- selectBestPhoto picks largest under 4MB --");
  {
    const photos = [
      { file_id: "small", file_unique_id: "s1", width: 90, height: 90, file_size: 1000 },
      { file_id: "medium", file_unique_id: "s2", width: 320, height: 320, file_size: 50_000 },
      { file_id: "large", file_unique_id: "s3", width: 800, height: 800, file_size: 200_000 },
      { file_id: "xlarge", file_unique_id: "s4", width: 1280, height: 1280, file_size: 3_000_000 },
    ];

    const best = selectBestPhoto(photos);
    assert(best !== null && best.file_id === "xlarge", "selectBestPhoto picks largest under 4MB");
  }

  console.log("\n-- selectBestPhoto skips oversized, picks next largest --");
  {
    const photos = [
      { file_id: "small", file_unique_id: "s1", width: 90, height: 90, file_size: 1000 },
      { file_id: "medium", file_unique_id: "s2", width: 320, height: 320, file_size: 50_000 },
      { file_id: "oversized", file_unique_id: "s3", width: 2560, height: 2560, file_size: 6_000_000 },
    ];

    const best = selectBestPhoto(photos);
    assert(best !== null && best.file_id === "medium", "selectBestPhoto skips oversized, picks next largest");
  }

  console.log("\n-- selectBestPhoto returns null when all over cap --");
  {
    const photos = [
      { file_id: "big1", file_unique_id: "b1", width: 800, height: 800, file_size: 6_000_000 },
      { file_id: "big2", file_unique_id: "b2", width: 1600, height: 1600, file_size: 8_000_000 },
    ];

    const best = selectBestPhoto(photos);
    assert(best === null, "selectBestPhoto returns null when all known sizes exceed cap");
  }

  console.log("\n-- selectBestPhoto picks second-to-last when all sizes unknown --");
  {
    const photos = [
      { file_id: "a", file_unique_id: "a1", width: 90, height: 90 },
      { file_id: "b", file_unique_id: "b1", width: 320, height: 320 },
      { file_id: "c", file_unique_id: "c1", width: 800, height: 800 },
    ];

    const best = selectBestPhoto(photos);
    assert(best !== null && best.file_id === "b", "selectBestPhoto picks second-to-last when all sizes unknown");
  }

  console.log("\n-- selectBestPhoto handles single element with unknown size --");
  {
    const photos = [
      { file_id: "only", file_unique_id: "o1", width: 320, height: 320 },
    ];

    const best = selectBestPhoto(photos);
    assert(best !== null && best.file_id === "only", "selectBestPhoto returns single photo when size unknown");
  }

  console.log("\n-- selectBestPhoto handles empty array --");
  {
    const best = selectBestPhoto([]);
    assert(best === null, "selectBestPhoto returns null for empty array");
  }

  console.log("\n-- selectBestPhoto mixed known/unknown picks fallback --");
  {
    // All known sizes exceed cap, but one variant has unknown size.
    // Should fall back to second-to-last (medium) instead of returning null.
    const photos = [
      { file_id: "small-over", file_unique_id: "s1", width: 320, height: 320, file_size: 6_000_000 },
      { file_id: "medium-unknown", file_unique_id: "m1", width: 800, height: 800 },
      { file_id: "large-over", file_unique_id: "l1", width: 1600, height: 1600, file_size: 8_000_000 },
    ];

    const best = selectBestPhoto(photos);
    assert(best !== null, "selectBestPhoto mixed known/unknown does not return null");
    assert(best!.file_id === "medium-unknown", "selectBestPhoto mixed case picks second-to-last (unknown size)");
  }

  console.log("\n-- normalize photo update --");
  {
    const photoUpdate = {
      update_id: 2001,
      message: {
        message_id: 201,
        from: { id: 42 },
        chat: { id: 777, type: "private" as const },
        date: 1,
        photo: [
          { file_id: "thumb", file_unique_id: "t1", width: 90, height: 90, file_size: 1200 },
          { file_id: "medium", file_unique_id: "t2", width: 320, height: 320, file_size: 25000 },
          { file_id: "full", file_unique_id: "t3", width: 800, height: 800, file_size: 120000 },
        ],
      },
    };

    const normalized = normalizeInboundUpdate(photoUpdate);
    assert(normalized !== null, "normalizes photo update");
    assert(normalized?.media?.kind === "photo", "photo envelope marks media kind");
    assert(normalized?.media?.fileId === "full", "photo envelope picks largest under cap");
    assert(normalized?.media?.mimeType === "image/jpeg", "photo envelope hardcodes image/jpeg mime");
  }

  console.log("\n-- normalize photo with caption --");
  {
    const captionPhotoUpdate = {
      update_id: 2002,
      message: {
        message_id: 202,
        from: { id: 42 },
        chat: { id: 777, type: "private" as const },
        date: 1,
        caption: "Check this out",
        photo: [
          { file_id: "thumb2", file_unique_id: "t4", width: 90, height: 90, file_size: 1200 },
          { file_id: "full2", file_unique_id: "t5", width: 800, height: 800, file_size: 120000 },
        ],
      },
    };

    const normalized = normalizeInboundUpdate(captionPhotoUpdate);
    assert(normalized !== null, "normalizes photo with caption");
    assert(normalized?.text === "Check this out", "photo with caption extracts caption text");
    assert(normalized?.media?.kind === "photo", "photo with caption includes media envelope");
  }

  console.log("\n-- normalize document_image update --");
  {
    const docImageUpdate = {
      update_id: 2003,
      message: {
        message_id: 203,
        from: { id: 42 },
        chat: { id: 777, type: "private" as const },
        date: 1,
        document: {
          file_id: "doc-image-1",
          file_name: "screenshot.png",
          mime_type: "image/png",
          file_size: 350000,
        },
      },
    };

    const normalized = normalizeInboundUpdate(docImageUpdate);
    assert(normalized !== null, "normalizes document image update");
    assert(normalized?.media?.kind === "document_image", "document image marks media kind");
    assert(normalized?.media?.mimeType === "image/png", "document image uses document mime type");
    assert(normalized?.media?.fileName === "screenshot.png", "document image captures file name");
  }

  console.log("\n-- non-image document still ignored without text --");
  {
    const pdfDoc = normalizeInboundUpdate({
      update_id: 2004,
      message: {
        message_id: 204,
        from: { id: 42 },
        chat: { id: 777, type: "private" as const },
        date: 1,
        document: {
          file_id: "doc-pdf-1",
          file_name: "report.pdf",
          mime_type: "application/pdf",
        },
      },
    });

    assert(pdfDoc === null, "non-image/non-audio documents without text are still ignored");
  }

  console.log("\n-- oversized photo with caption falls back to text-only --");
  {
    const oversizedPhotoUpdate = {
      update_id: 2005,
      message: {
        message_id: 205,
        from: { id: 42 },
        chat: { id: 777, type: "private" as const },
        date: 1,
        caption: "huge photo caption",
        photo: [
          { file_id: "big1", file_unique_id: "b1", width: 800, height: 800, file_size: 6_000_000 },
          { file_id: "big2", file_unique_id: "b2", width: 1600, height: 1600, file_size: 8_000_000 },
        ],
      },
    };

    const normalized = normalizeInboundUpdate(oversizedPhotoUpdate);
    assert(normalized !== null, "oversized photo with caption still produces envelope");
    assert(normalized?.text === "huge photo caption", "oversized photo preserves caption text");
    assert(normalized?.media === undefined, "oversized photo drops media envelope");
  }

  console.log("\n-- oversized captionless photo is dropped --");
  {
    const oversizedNoCaptionUpdate = {
      update_id: 2006,
      message: {
        message_id: 206,
        from: { id: 42 },
        chat: { id: 777, type: "private" as const },
        date: 1,
        photo: [
          { file_id: "big1", file_unique_id: "b1", width: 800, height: 800, file_size: 6_000_000 },
        ],
      },
    };

    const normalized = normalizeInboundUpdate(oversizedNoCaptionUpdate);
    assert(normalized === null, "oversized captionless photo is dropped");
  }

  console.log("\n-- mixed known/unknown sizes: all known over cap but unknown exists --");
  {
    // All known file_sizes exceed 4MB but one variant has unknown size.
    // Before fix this returned null (drop). Now it falls back to medium resolution.
    const mixedSizesUpdate = {
      update_id: 2007,
      message: {
        message_id: 207,
        from: { id: 42 },
        chat: { id: 777, type: "private" as const },
        date: 1,
        photo: [
          { file_id: "small-over", file_unique_id: "s", width: 320, height: 320, file_size: 6_000_000 },
          { file_id: "medium-unknown", file_unique_id: "m", width: 800, height: 800 },
          { file_id: "large-over", file_unique_id: "l", width: 1600, height: 1600, file_size: 8_000_000 },
        ],
      },
    };

    const normalized = normalizeInboundUpdate(mixedSizesUpdate);
    assert(normalized !== null, "mixed sizes with unknown fallback still produces envelope");
    assert(normalized?.media?.fileId === "medium-unknown", "mixed sizes picks unknown variant (second-to-last) when all known exceed cap");
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n=== Results: ${PASS} passed, ${FAIL} failed ===`);
process.exit(FAIL > 0 ? 1 : 0);
