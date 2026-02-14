export const INTERACTIVE_ONLY_SLASH_COMMANDS = new Set([
  "settings",
  "hotkeys",
  "theme",
  "themes",
  "help",
]);

export interface SlashCommandEntry {
  name: string;
  source: string;
  description: string;
  path: string;
  location: string;
}

export interface SlashParseResult {
  kind: "not_slash" | "invalid" | "slash";
  isSlash: boolean;
  raw: string;
  trimmed: string;
  commandName: string;
  commandToken: string;
}

export interface SlashClassification extends SlashParseResult {
  supported?: boolean;
  reason?: "interactive_only" | "unsupported";
  command?: SlashCommandEntry;
  commandSource?: string;
}

export function normalizeCommandName(name: unknown): string {
  if (typeof name !== "string") {
    return "";
  }
  const trimmed = name.trim();
  if (!trimmed) {
    return "";
  }
  return trimmed.replace(/^\/+/, "").toLowerCase();
}

export function parseSlashInput(message: unknown): SlashParseResult {
  const raw = typeof message === "string" ? message : "";
  const trimmed = raw.trim();

  if (!trimmed.startsWith("/") || trimmed.startsWith("//")) {
    return {
      kind: "not_slash",
      isSlash: false,
      raw,
      trimmed,
      commandName: "",
      commandToken: "",
    };
  }

  const body = trimmed.slice(1);
  const commandToken = body.split(/\s+/, 1)[0] ?? "";
  const commandTokenWithoutTarget = commandToken.split("@", 1)[0] ?? "";
  const commandName = normalizeCommandName(commandTokenWithoutTarget);

  if (!commandName) {
    return {
      kind: "invalid",
      isSlash: true,
      raw,
      trimmed,
      commandName: "",
      commandToken,
    };
  }

  return {
    kind: "slash",
    isSlash: true,
    raw,
    trimmed,
    commandName,
    commandToken,
  };
}

export function normalizeCommandsPayload(payload: unknown): SlashCommandEntry[] {
  if (!payload) {
    return [];
  }

  const commands = Array.isArray(payload)
    ? payload
    : Array.isArray((payload as any).commands)
      ? (payload as any).commands
      : Array.isArray((payload as any).data?.commands)
        ? (payload as any).data.commands
        : [];

  return commands
    .map((command) => {
      if (!command || typeof command !== "object") {
        return null;
      }

      const name = normalizeCommandName((command as any).name);
      if (!name) {
        return null;
      }

      return {
        name,
        source: typeof (command as any).source === "string" ? (command as any).source : "unknown",
        description: typeof (command as any).description === "string" ? (command as any).description : "",
        path: typeof (command as any).path === "string" ? (command as any).path : "",
        location: typeof (command as any).location === "string" ? (command as any).location : "",
      } satisfies SlashCommandEntry;
    })
    .filter((command): command is SlashCommandEntry => Boolean(command));
}

export function buildCommandIndex(commands: unknown): Map<string, SlashCommandEntry> {
  const index = new Map<string, SlashCommandEntry>();
  for (const command of normalizeCommandsPayload(commands)) {
    index.set(command.name, command);
  }
  return index;
}

export function classifySlashCommand(
  message: unknown,
  commandIndex: Map<string, SlashCommandEntry> | unknown,
  options: { interactiveOnlyCommands?: Set<string> } = {},
): SlashClassification {
  const parsed = parseSlashInput(message);
  if (!parsed.isSlash) {
    return parsed;
  }
  if (!parsed.commandName) {
    return parsed;
  }

  const commandMap = commandIndex instanceof Map ? commandIndex : buildCommandIndex(commandIndex);
  const command = commandMap.get(parsed.commandName);
  if (command) {
    return {
      ...parsed,
      kind: "supported",
      supported: true,
      command,
      commandSource: command.source,
    };
  }

  const interactiveOnly = options.interactiveOnlyCommands instanceof Set
    ? options.interactiveOnlyCommands
    : INTERACTIVE_ONLY_SLASH_COMMANDS;

  if (interactiveOnly.has(parsed.commandName)) {
    return {
      ...parsed,
      kind: "interactive_only",
      supported: false,
      reason: "interactive_only",
    };
  }

  return {
    ...parsed,
    kind: "unsupported",
    supported: false,
    reason: "unsupported",
  };
}

function shortcutSuggestion(commandName: string): string | null {
  if (commandName === "status") return "Try /telegram status.";
  if (commandName === "check") return "Try /telegram check.";
  return null;
}

export function formatUnsupportedMessage(classification: SlashClassification): string {
  const command = classification?.commandName ? `/${classification.commandName}` : "slash command";
  if (classification?.kind === "interactive_only") {
    return `Unsupported slash command ${command}. This command only runs in the interactive TUI.`;
  }
  if (classification?.kind === "invalid") {
    return "Invalid slash command. Enter a command name after /.";
  }

  if (classification?.commandName) {
    const suggestion = shortcutSuggestion(classification.commandName);
    if (suggestion) {
      return `Unsupported slash command ${command}. ${suggestion}`;
    }
  }

  return `Unsupported slash command ${command}. Choose a command returned by get_commands.`;
}

export function formatSlashAcknowledgement(inputMessage: string): string {
  const parsed = parseSlashInput(inputMessage);
  const command = parsed.commandName ? `/${parsed.commandName}` : "slash command";
  const tokens = parsed.trimmed.split(/\s+/).filter(Boolean);
  const firstArg = tokens.length > 1 ? ` ${tokens[1]}` : "";
  return `✅ ${command}${firstArg} executed.`;
}

export function formatSlashPromptFailure(inputMessage: string, rawError: string): string {
  const parsed = parseSlashInput(inputMessage);
  const message = String(rawError || "RPC prompt failed").trim() || "RPC prompt failed";

  if (!parsed.isSlash) {
    return message;
  }

  const command = parsed.commandName ? `/${parsed.commandName}` : "slash command";

  if (/unknown command|not found|unrecognized|unsupported/i.test(message)) {
    const suggestion = parsed.commandName ? shortcutSuggestion(parsed.commandName) : null;
    if (suggestion) {
      return `Unsupported slash command ${command}. ${suggestion}`;
    }
    return `Unsupported slash command ${command}. Choose a command returned by get_commands.`;
  }

  if (/interactive TUI/i.test(message)) {
    return message;
  }

  if (/streamingbehavior|already streaming|session busy|busy/i.test(message)) {
    return `Slash command ${command} could not run because the session is busy. Retry in a moment.`;
  }

  if (/timed out/i.test(message)) {
    return `Slash command ${command} timed out. Retry in a moment.`;
  }

  return `Slash command ${command} failed: ${message}`;
}
