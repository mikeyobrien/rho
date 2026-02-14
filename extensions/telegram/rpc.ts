import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import {
  buildCommandIndex,
  classifySlashCommand,
  formatSlashAcknowledgement,
  formatSlashPromptFailure,
  formatUnsupportedMessage,
  INTERACTIVE_ONLY_SLASH_COMMANDS,
  parseSlashInput,
  type SlashClassification,
  type SlashCommandEntry,
} from "./slash-contract.ts";

const SLASH_COMMAND_DISCOVERY_TIMEOUT_MS = 1_000;

interface PendingPrompt {
  resolve: (value: string) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  requestId: string;
  inputMessage: string;
  isSlashCommand: boolean;
  sawPromptResponse: boolean;
  sawAgentEnd: boolean;
  lastAssistantText: string;
  stderrLines: string[];
}

interface PendingCommandsRequest {
  requestId: string;
  timer: NodeJS.Timeout;
  resolve: (value: Map<string, SlashCommandEntry> | null) => void;
}

interface RpcSessionState {
  sessionFile: string;
  process: ChildProcessWithoutNullStreams;
  buffer: string;
  connected: boolean;
  pending: PendingPrompt | null;
  commandIndex: Map<string, SlashCommandEntry>;
  commandsLoaded: boolean;
  pendingCommandsRequest: PendingCommandsRequest | null;
}

function extractAssistantText(message: any): string {
  if (!message || message.role !== "assistant") return "";
  const content = Array.isArray(message.content) ? message.content : [];
  const chunks: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    if (part.type === "text" && typeof part.text === "string") chunks.push(part.text);
  }
  return chunks.join("\n").trim();
}

function isIgnorableRpcStderr(message: string): boolean {
  const line = message.trim();
  if (!line) return true;
  return (
    /ExperimentalWarning: SQLite is an experimental feature/i.test(line)
    || /\(Use `node --trace-warnings .+\)/i.test(line)
    || /ExperimentalWarning/i.test(line)
  );
}

function formatStderrSuffix(lines: string[]): string {
  if (lines.length === 0) return "";
  const joined = lines.slice(-8).join("\n");
  return `\nRPC stderr:\n${joined}`;
}

function normalizeSlashPromptForRpc(message: string): string {
  const parsed = parseSlashInput(message);
  if (!parsed.isSlash || !parsed.commandName) return message;

  const token = parsed.trimmed.split(/\s+/, 1)[0] ?? "";
  if (!token.includes("@")) return message;

  const rest = parsed.trimmed.slice(token.length);
  return `/${parsed.commandName}${rest}`;
}

export class TelegramRpcRunner {
  private readonly sessions = new Map<string, RpcSessionState>();
  private readonly spawnProcess: typeof spawn;
  private promptRequestCounter = 0;
  private commandsRequestCounter = 0;

  constructor(spawnProcess: typeof spawn = spawn) {
    this.spawnProcess = spawnProcess;
  }

  async runPrompt(sessionFile: string, message: string, timeoutMs = 120_000): Promise<string> {
    const session = this.ensureSession(sessionFile);
    if (session.pending) {
      throw new Error(`RPC session busy for ${sessionFile}`);
    }

    const normalizedMessage = normalizeSlashPromptForRpc(message);
    const slashClassification = await this.classifySlashPrompt(session, normalizedMessage, timeoutMs);
    if (slashClassification && slashClassification.kind !== "supported") {
      throw new Error(formatUnsupportedMessage(slashClassification));
    }

    const requestId = `prompt-${++this.promptRequestCounter}`;

    return await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = session.pending;
        if (!pending || pending.requestId !== requestId) return;

        this.rejectPending(session, `RPC prompt timed out after ${Math.floor(timeoutMs / 1000)}s`);
      }, timeoutMs);

      session.pending = {
        resolve,
        reject,
        timer,
        requestId,
        inputMessage: normalizedMessage,
        isSlashCommand: parseSlashInput(normalizedMessage).isSlash,
        sawPromptResponse: false,
        sawAgentEnd: false,
        lastAssistantText: "",
        stderrLines: [],
      };

      this.sendCommand(session, { id: requestId, type: "prompt", message: normalizedMessage });
    });
  }

  dispose(): void {
    for (const session of this.sessions.values()) {
      try { session.process.kill("SIGTERM"); } catch {}
      if (session.pending) {
        this.rejectPending(session, "RPC session disposed");
      }
      this.resolveCommandsRequest(session, null);
    }
    this.sessions.clear();
  }

  private ensureSession(sessionFile: string): RpcSessionState {
    const existing = this.sessions.get(sessionFile);
    if (existing && !existing.process.killed) return existing;

    const child = this.spawnProcess("pi", ["--mode", "rpc"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        // Prevent telegram polling inside RPC worker while keeping other extensions available.
        RHO_TELEGRAM_DISABLE: "1",
      },
    });

    const state: RpcSessionState = {
      sessionFile,
      process: child,
      buffer: "",
      connected: false,
      pending: null,
      commandIndex: new Map(),
      commandsLoaded: false,
      pendingCommandsRequest: null,
    };

    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");

    child.stdout.on("data", (chunk: string) => {
      state.buffer += chunk;
      let idx = state.buffer.indexOf("\n");
      while (idx >= 0) {
        const line = state.buffer.slice(0, idx).trim();
        state.buffer = state.buffer.slice(idx + 1);
        if (line) this.handleLine(state, line);
        idx = state.buffer.indexOf("\n");
      }
    });

    child.stderr.on("data", (chunk: string) => {
      if (!state.pending) return;
      for (const rawLine of String(chunk || "").split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line) continue;
        if (isIgnorableRpcStderr(line)) continue;
        state.pending.stderrLines.push(line);
      }
    });

    child.once("exit", (code, signal) => {
      if (state.pending) {
        this.rejectPending(state, `RPC exited (code=${code ?? "null"}, signal=${signal ?? "null"})`);
      }
      this.resolveCommandsRequest(state, null);
      this.sessions.delete(sessionFile);
    });

    this.sessions.set(sessionFile, state);

    this.sendCommand(state, {
      type: "switch_session",
      sessionFile,
      sessionPath: sessionFile,
      path: sessionFile,
    });
    this.sendCommand(state, { type: "get_state" });

    return state;
  }

  private sendCommand(session: RpcSessionState, command: Record<string, unknown>): void {
    if (session.process.stdin.destroyed || !session.process.stdin.writable) {
      throw new Error(`RPC stdin is not writable for ${session.sessionFile}`);
    }
    session.process.stdin.write(JSON.stringify(command) + "\n", "utf-8");
  }

  private clearPendingTimers(pending: PendingPrompt): void {
    clearTimeout(pending.timer);
  }

  private resolvePromptText(pending: PendingPrompt): string {
    if (pending.lastAssistantText) return pending.lastAssistantText;
    if (pending.isSlashCommand && pending.sawPromptResponse) {
      return formatSlashAcknowledgement(pending.inputMessage);
    }
    return "";
  }

  private resolvePending(session: RpcSessionState, text: string): void {
    const pending = session.pending;
    if (!pending) return;

    session.pending = null;
    this.clearPendingTimers(pending);
    pending.resolve(text);
  }

  private rejectPending(session: RpcSessionState, message: string): void {
    const pending = session.pending;
    if (!pending) return;

    session.pending = null;
    this.clearPendingTimers(pending);
    pending.reject(new Error(`${message}${formatStderrSuffix(pending.stderrLines)}`));
  }

  private resolveCommandsRequest(session: RpcSessionState, commands: Map<string, SlashCommandEntry> | null): void {
    const pendingRequest = session.pendingCommandsRequest;
    if (!pendingRequest) {
      return;
    }

    session.pendingCommandsRequest = null;
    clearTimeout(pendingRequest.timer);

    if (commands) {
      session.commandIndex = commands;
      session.commandsLoaded = true;
    }

    pendingRequest.resolve(commands);
  }

  private async loadCommandIndex(session: RpcSessionState, timeoutMs: number): Promise<Map<string, SlashCommandEntry> | null> {
    if (session.commandsLoaded) {
      return session.commandIndex;
    }

    if (session.pendingCommandsRequest) {
      return await new Promise((resolve) => {
        const existing = session.pendingCommandsRequest;
        if (!existing) {
          resolve(null);
          return;
        }

        const poll = setInterval(() => {
          if (session.pendingCommandsRequest === existing) {
            return;
          }
          clearInterval(poll);
          resolve(session.commandsLoaded ? session.commandIndex : null);
        }, 10);

        setTimeout(() => {
          clearInterval(poll);
          resolve(session.commandsLoaded ? session.commandIndex : null);
        }, timeoutMs + 25);
      });
    }

    const requestId = `commands-${++this.commandsRequestCounter}`;
    const safeTimeoutMs = Math.max(100, Math.min(timeoutMs, SLASH_COMMAND_DISCOVERY_TIMEOUT_MS));

    return await new Promise<Map<string, SlashCommandEntry> | null>((resolve) => {
      const timer = setTimeout(() => {
        if (session.pendingCommandsRequest?.requestId !== requestId) return;
        this.resolveCommandsRequest(session, null);
      }, safeTimeoutMs);

      session.pendingCommandsRequest = {
        requestId,
        timer,
        resolve,
      };

      try {
        this.sendCommand(session, { id: requestId, type: "get_commands" });
      } catch {
        this.resolveCommandsRequest(session, null);
      }
    });
  }

  private async classifySlashPrompt(
    session: RpcSessionState,
    message: string,
    timeoutMs: number,
  ): Promise<SlashClassification | null> {
    const parsed = parseSlashInput(message);
    if (!parsed.isSlash) {
      return null;
    }

    const commandIndex = await this.loadCommandIndex(session, timeoutMs);
    if (!commandIndex) {
      throw new Error("Slash command inventory unavailable. Retry in a moment.");
    }

    return classifySlashCommand(message, commandIndex, {
      interactiveOnlyCommands: INTERACTIVE_ONLY_SLASH_COMMANDS,
    });
  }

  private handleLine(session: RpcSessionState, line: string): void {
    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }

    if (!session.connected) session.connected = true;

    if (event.type === "response" && event.command === "get_commands") {
      const pendingRequest = session.pendingCommandsRequest;
      if (!pendingRequest) {
        return;
      }

      const responseId = typeof event.id === "string" ? event.id : null;
      if (responseId && responseId !== pendingRequest.requestId) {
        return;
      }

      if (event.success === false) {
        this.resolveCommandsRequest(session, null);
        return;
      }

      const commands = buildCommandIndex(event.data ?? event.commands ?? []);
      this.resolveCommandsRequest(session, commands);
      return;
    }

    if (!session.pending) return;

    if (event.type === "response" && event.command === "prompt") {
      const pending = session.pending;
      if (!pending) return;

      const responseId = typeof event.id === "string" ? event.id : null;
      if (responseId && responseId !== pending.requestId) return;

      if (event.success === false) {
        const mapped = formatSlashPromptFailure(pending.inputMessage, String(event.error || "RPC prompt failed"));
        this.rejectPending(session, mapped);
        return;
      }

      pending.sawPromptResponse = true;
      return;
    }

    if (event.type === "message_end") {
      const pending = session.pending;
      if (!pending) return;

      const maybeText = extractAssistantText(event.message);
      if (maybeText) {
        pending.lastAssistantText = maybeText;
        if (pending.isSlashCommand && pending.sawPromptResponse) {
          this.resolvePending(session, pending.lastAssistantText);
        }
      }
      return;
    }

    if (event.type === "agent_end") {
      const pending = session.pending;
      if (!pending) return;

      pending.sawAgentEnd = true;
      this.resolvePending(session, this.resolvePromptText(pending));
      return;
    }

    if (event.type === "rpc_error" || event.type === "rpc_process_crashed") {
      const pending = session.pending;
      if (!pending) return;

      const mapped = formatSlashPromptFailure(pending.inputMessage, String(event.message || "RPC error"));
      this.rejectPending(session, mapped);
    }
  }
}
