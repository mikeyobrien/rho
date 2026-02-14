const INTERACTIVE_ONLY_SLASH_COMMANDS = new Set([
  "settings",
  "hotkeys",
  "theme",
  "themes",
  "help",
]);

function normalizeCommandName(name) {
  if (typeof name !== "string") {
    return "";
  }
  const trimmed = name.trim();
  if (!trimmed) {
    return "";
  }
  return trimmed.replace(/^\/+/, "").toLowerCase();
}

function parseSlashInput(message) {
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

function normalizeCommandsPayload(payload) {
  if (!payload) {
    return [];
  }

  const commands = Array.isArray(payload)
    ? payload
    : Array.isArray(payload.commands)
      ? payload.commands
      : Array.isArray(payload.data?.commands)
        ? payload.data.commands
        : [];

  return commands
    .map((command) => {
      if (!command || typeof command !== "object") {
        return null;
      }

      const name = normalizeCommandName(command.name);
      if (!name) {
        return null;
      }

      return {
        name,
        source: typeof command.source === "string" ? command.source : "unknown",
        description: typeof command.description === "string" ? command.description : "",
        path: typeof command.path === "string" ? command.path : "",
        location: typeof command.location === "string" ? command.location : "",
      };
    })
    .filter(Boolean);
}

function buildCommandIndex(commands) {
  const index = new Map();
  for (const command of normalizeCommandsPayload(commands)) {
    index.set(command.name, command);
  }
  return index;
}

function classifySlashCommand(message, commandIndex, options = {}) {
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

function resolvePromptOptions(classification, isStreaming, defaultStreamingBehavior = "steer") {
  if (!classification || classification.kind !== "supported" || !isStreaming) {
    return {};
  }

  // Extension commands are executed immediately by `prompt` during streaming.
  if (classification.commandSource === "extension") {
    return {};
  }

  return {
    streamingBehavior: defaultStreamingBehavior,
  };
}

function shortcutSuggestion(commandName) {
  if (commandName === "status") return "Try /telegram status.";
  if (commandName === "check") return "Try /telegram check.";
  return null;
}

function formatUnsupportedMessage(classification) {
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

function formatPromptFailure(inputMessage, rawError) {
  const parsed = parseSlashInput(inputMessage);
  const message = typeof rawError === "string" && rawError.trim() ? rawError.trim() : "RPC prompt failed";

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

const contract = {
  INTERACTIVE_ONLY_SLASH_COMMANDS,
  normalizeCommandName,
  parseSlashInput,
  normalizeCommandsPayload,
  buildCommandIndex,
  classifySlashCommand,
  resolvePromptOptions,
  formatUnsupportedMessage,
  formatPromptFailure,
};

if (typeof globalThis !== "undefined") {
  globalThis.__rhoSlashContract = contract;
}
