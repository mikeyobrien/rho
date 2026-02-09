import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";

type EventHandler = (event: RPCEvent) => void;

export type RPCCommand = {
  type: string;
  id?: string;
  [key: string]: unknown;
};

export type RPCEvent = {
  type: string;
  [key: string]: unknown;
};

export interface ActiveSession {
  id: string;
  sessionFile: string;
  startedAt: string;
  lastActivityAt: string;
  pid: number | null;
}

interface SessionState {
  id: string;
  sessionFile: string;
  process: ChildProcessWithoutNullStreams;
  handlers: Set<EventHandler>;
  buffer: string;
  startedAt: Date;
  lastActivityAt: Date;
  connected: boolean;
  connectionTimer: NodeJS.Timeout;
  idleTimer: NodeJS.Timeout;
  shutdownTimer: NodeJS.Timeout | null;
  stopping: boolean;
}

const CONNECTION_TIMEOUT_MS = 60_000;
const IDLE_TIMEOUT_MS = 10 * 60_000;
const KILL_TIMEOUT_MS = 2_000;

function nowIso(): string {
  return new Date().toISOString();
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return typeof error === "string" ? error : "Unknown RPC error";
}

export class RPCManager {
  private readonly sessions = new Map<string, SessionState>();

  startSession(sessionFile: string): string {
    if (!sessionFile?.trim()) {
      throw new Error("sessionFile is required");
    }

    const id = randomUUID();
    const child = spawn("pi", ["--mode", "rpc", "--no-session"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });

    const state: SessionState = {
      id,
      sessionFile,
      process: child,
      handlers: new Set<EventHandler>(),
      buffer: "",
      startedAt: new Date(),
      lastActivityAt: new Date(),
      connected: false,
      connectionTimer: setTimeout(() => {
        if (!state.connected) {
          this.emit(id, {
            type: "rpc_error",
            phase: "connect",
            message: `RPC connection timeout after ${Math.floor(CONNECTION_TIMEOUT_MS / 1000)}s`,
          });
          this.stopSession(id);
        }
      }, CONNECTION_TIMEOUT_MS),
      idleTimer: setTimeout(() => {
        this.emit(id, {
          type: "rpc_idle_timeout",
          message: "Session stopped after 10 minutes of inactivity",
        });
        this.stopSession(id);
      }, IDLE_TIMEOUT_MS),
      shutdownTimer: null,
      stopping: false,
    };

    state.connectionTimer.unref?.();
    state.idleTimer.unref?.();

    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");

    child.stdout.on("data", (chunk: string) => {
      state.buffer += chunk;
      state.lastActivityAt = new Date();

      let newlineIndex = state.buffer.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = state.buffer.slice(0, newlineIndex).trim();
        state.buffer = state.buffer.slice(newlineIndex + 1);

        if (line.length > 0) {
          this.handleLine(state, line);
        }

        newlineIndex = state.buffer.indexOf("\n");
      }
    });

    child.stderr.on("data", (chunk: string) => {
      const message = chunk.trim();
      if (!message) {
        return;
      }
      this.emit(id, { type: "rpc_stderr", message });
    });

    child.once("error", (error) => {
      this.emit(id, {
        type: "rpc_error",
        phase: "spawn",
        message: toErrorMessage(error),
      });
      this.stopSession(id);
    });

    child.once("exit", (code, signal) => {
      this.clearTimers(state);
      const expected = state.stopping;
      this.emit(id, {
        type: expected ? "rpc_session_stopped" : "rpc_process_crashed",
        code,
        signal,
      });
      this.sessions.delete(id);
    });

    this.sessions.set(id, state);

    this.sendCommand(id, {
      type: "switch_session",
      sessionFile,
      sessionPath: sessionFile,
      path: sessionFile,
    });

    this.sendCommand(id, { type: "get_state" });

    return id;
  }

  sendCommand(sessionId: string, command: RPCCommand): void {
    const state = this.sessions.get(sessionId);
    if (!state) {
      throw new Error(`Unknown RPC session: ${sessionId}`);
    }

    if (!command?.type) {
      throw new Error("RPC command must include a type");
    }

    if (state.process.stdin.destroyed || !state.process.stdin.writable) {
      throw new Error(`RPC session ${sessionId} is not writable`);
    }

    const line = `${JSON.stringify(command)}\n`;
    state.process.stdin.write(line, "utf-8");
    state.lastActivityAt = new Date();
    this.resetIdleTimer(state);
  }

  onEvent(sessionId: string, handler: EventHandler): () => void {
    const state = this.sessions.get(sessionId);
    if (!state) {
      throw new Error(`Unknown RPC session: ${sessionId}`);
    }

    state.handlers.add(handler);
    return () => {
      state.handlers.delete(handler);
    };
  }

  stopSession(sessionId: string): void {
    const state = this.sessions.get(sessionId);
    if (!state || state.stopping) {
      return;
    }

    state.stopping = true;
    this.clearTimers(state);

    if (!state.process.killed) {
      state.process.kill("SIGTERM");
      state.shutdownTimer = setTimeout(() => {
        if (!state.process.killed) {
          state.process.kill("SIGKILL");
        }
      }, KILL_TIMEOUT_MS);
      state.shutdownTimer.unref?.();
    }
  }

  getActiveSessions(): ActiveSession[] {
    return [...this.sessions.values()].map((state) => ({
      id: state.id,
      sessionFile: state.sessionFile,
      startedAt: state.startedAt.toISOString(),
      lastActivityAt: state.lastActivityAt.toISOString(),
      pid: state.process.pid ?? null,
    }));
  }

  dispose(): void {
    for (const sessionId of this.sessions.keys()) {
      this.stopSession(sessionId);
    }
  }

  private resetIdleTimer(state: SessionState): void {
    clearTimeout(state.idleTimer);
    state.idleTimer = setTimeout(() => {
      this.emit(state.id, {
        type: "rpc_idle_timeout",
        message: "Session stopped after 10 minutes of inactivity",
      });
      this.stopSession(state.id);
    }, IDLE_TIMEOUT_MS);
    state.idleTimer.unref?.();
  }

  private clearTimers(state: SessionState): void {
    clearTimeout(state.connectionTimer);
    clearTimeout(state.idleTimer);
    if (state.shutdownTimer) {
      clearTimeout(state.shutdownTimer);
      state.shutdownTimer = null;
    }
  }

  private handleLine(state: SessionState, line: string): void {
    let event: RPCEvent;
    try {
      event = JSON.parse(line) as RPCEvent;
    } catch {
      this.emit(state.id, {
        type: "rpc_error",
        phase: "parse",
        message: "Failed to parse RPC stdout line as JSON",
        line,
      });
      return;
    }

    if (!state.connected) {
      state.connected = true;
      clearTimeout(state.connectionTimer);
    }

    this.emit(state.id, event);
  }

  private emit(sessionId: string, event: RPCEvent): void {
    const state = this.sessions.get(sessionId);
    if (!state) {
      return;
    }

    for (const handler of state.handlers) {
      try {
        handler(event);
      } catch {
        // Subscriber failures should not break RPC session processing.
      }
    }
  }
}

export const rpcManager = new RPCManager();

export function getRpcSessionFile(command: RPCCommand | null | undefined): string | null {
  if (!command || typeof command !== "object") {
    return null;
  }

  const candidate =
    (typeof command.sessionFile === "string" && command.sessionFile) ||
    (typeof command.sessionPath === "string" && command.sessionPath) ||
    (typeof command.path === "string" && command.path) ||
    (typeof command.file === "string" && command.file) ||
    null;

  if (!candidate) {
    return null;
  }

  return candidate.trim() || null;
}

export function createSessionNotFoundError(sessionId: string): RPCEvent {
  return {
    type: "rpc_error",
    phase: "command",
    message: `Unknown RPC session: ${sessionId}`,
    timestamp: nowIso(),
  };
}
