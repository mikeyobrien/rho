const CHAT_REFRESH_INTERVAL = 15000;

function safeString(value) {
  if (value == null) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function clampString(value, max) {
  if (!value) {
    return "";
  }
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, max)}...`;
}

function generateOutputPreview(output, maxLen = 80) {
  if (!output) return '';
  const oneLine = output.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
  return oneLine.length > maxLen ? oneLine.substring(0, maxLen) + '...' : oneLine;
}

function extractText(content) {
  if (content == null) {
    return "";
  }
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === "string") {
          return item;
        }
        if (item && typeof item === "object" && "text" in item) {
          return String(item.text ?? "");
        }
        return "";
      })
      .filter(Boolean)
      .join(" ");
  }
  if (typeof content === "object" && "text" in content) {
    return String(content.text ?? "");
  }
  return safeString(content);
}

function normalizeToolCall(item) {
  const name =
    item.name ??
    item.tool_name ??
    item.toolName ??
    item.function?.name ??
    item.functionName ??
    "tool";
  const args =
    item.arguments ??
    item.args ??
    item.input ??
    item.function?.arguments ??
    item.parameters ??
    "";
  const output =
    item.output ??
    item.result ??
    item.response ??
    item.tool_output ??
    item.toolResult ??
    "";

  const argsText = typeof args === "string" ? args : safeString(args);
  const outputText = typeof output === "string" ? output : safeString(output);

  return {
    type: "tool_call",
    name,
    toolCallId: item.id ?? item.tool_use_id ?? item.toolUseId ?? "",
    args: argsText,
    argsSummary: clampString(argsText.replace(/\s+/g, " ").trim(), 120),
    output: outputText,
    outputPreview: generateOutputPreview(outputText),
    status: item.isError ? "error" : item.status ?? "done",
    duration: item.duration ?? "",
  };
}

function normalizeContentItem(item) {
  if (item == null) {
    return [];
  }
  if (typeof item === "string") {
    return [{ type: "text", text: item }];
  }
  if (typeof item !== "object") {
    return [{ type: "text", text: String(item) }];
  }

  const itemType = item.type;

  if (itemType === "thinking" || itemType === "reasoning" || itemType === "analysis") {
    return [{ type: "thinking", text: item.text ?? item.content ?? item.thought ?? "" }];
  }

  if (itemType === "toolCall") {
    const argsText = safeString(item.arguments ?? {});
    const outputText = item.output ?? "";
    return [
      {
        type: "tool_call",
        name: item.name ?? "tool",
        args: argsText,
        argsSummary: clampString(argsText.replace(/\s+/g, " ").trim(), 120),
        output: outputText,
        outputPreview: generateOutputPreview(outputText),
        toolCallId: item.id ?? "",
        status: outputText ? "done" : "running",
        duration: "",
      },
    ];
  }

  if (itemType === "tool_call" || itemType === "tool_use" || itemType === "tool") {
    return [normalizeToolCall(item)];
  }

  if (itemType === "tool_result" || itemType === "tool_output" || itemType === "tool_response") {
    // Tool results are merged into tool_call parts - return empty to skip standalone rendering
    // The merging happens in normalizeParts after all parts are collected
    return [
      {
        type: "tool_result",
        name: item.name ?? item.tool_name ?? "tool",
        toolUseId: item.tool_use_id ?? item.toolUseId ?? "",
        output: typeof item.output === "string" ? item.output : safeString(item.output ?? item.result ?? item),
      },
    ];
  }

  if (itemType === "bash" || itemType === "shell" || itemType === "command") {
    return [
      {
        type: "bash",
        command: item.command ?? item.cmd ?? item.text ?? "",
        output: item.output ?? item.result ?? "",
      },
    ];
  }

  if (itemType === "error") {
    return [{ type: "error", text: item.message ?? item.error ?? safeString(item) }];
  }

  if (itemType === "text" || itemType === "input_text" || itemType === "output_text" || itemType === "markdown") {
    return [{ type: "text", text: item.text ?? item.content ?? "" }];
  }

  if ("tool_calls" in item && Array.isArray(item.tool_calls)) {
    return item.tool_calls.map(normalizeToolCall);
  }

  if ("tool" in item || "toolName" in item || "function" in item) {
    return [normalizeToolCall(item)];
  }

  if ("thinking" in item) {
    return [{ type: "thinking", text: item.thinking }];
  }

  if ("command" in item || "cmd" in item) {
    return [
      {
        type: "bash",
        command: item.command ?? item.cmd ?? "",
        output: item.output ?? item.result ?? "",
      },
    ];
  }

  if ("error" in item) {
    return [{ type: "error", text: item.error ?? safeString(item) }];
  }

  if ("text" in item) {
    return [{ type: "text", text: item.text ?? "" }];
  }

  return [{ type: "text", text: safeString(item) }];
}

function normalizeParts(content) {
  if (content == null) {
    return [];
  }
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }
  if (Array.isArray(content)) {
    const rawParts = content.flatMap((item) => normalizeContentItem(item));
    // Merge tool_result into matching tool_call parts
    const toolCalls = rawParts.filter(p => p.type === "tool_call");
    const toolResults = rawParts.filter(p => p.type === "tool_result");
    const otherParts = rawParts.filter(p => p.type !== "tool_call" && p.type !== "tool_result");

    // Match results to calls by toolCallId/toolUseId or by name+position
    for (const result of toolResults) {
      let matched = false;
      // Try to match by ID first
      if (result.toolUseId) {
        const call = toolCalls.find(c => c.toolCallId === result.toolUseId && !c.output);
        if (call) {
          call.output = result.output;
          call.outputPreview = generateOutputPreview(result.output);
          call.status = "done";
          matched = true;
        }
      }
      // Fallback: match by name (first unmatched call with same name)
      if (!matched && result.name) {
        const call = toolCalls.find(c => c.name === result.name && !c.output);
        if (call) {
          call.output = result.output;
          call.outputPreview = generateOutputPreview(result.output);
          call.status = "done";
          matched = true;
        }
      }
      // If still not matched, match to any call without output
      if (!matched) {
        const call = toolCalls.find(c => !c.output);
        if (call) {
          call.output = result.output;
          call.outputPreview = generateOutputPreview(result.output);
          call.status = "done";
        }
      }
    }
    // Mark any remaining tool_calls without results as "done" (historical data, not running)
    for (const call of toolCalls) {
      if (call.status === "running") {
        call.status = "done";
      }
    }
    // Return tool_calls and other parts, excluding tool_result (merged into calls)
    return [...toolCalls, ...otherParts];
  }

  if (typeof content === "object") {
    const contentType = content.type;
    if (contentType === "compaction") {
      return [
        {
          type: "compaction",
          summary: content.summary ?? "Context compacted",
        },
      ];
    }

    if (contentType === "branch_summary") {
      return [
        {
          type: "summary",
          summary: content.summary ?? "Branch summary",
        },
      ];
    }

    if (contentType === "tool_call" || contentType === "tool_use" || contentType === "tool") {
      return [normalizeToolCall(content)];
    }

    if (contentType === "tool_result" || contentType === "tool_output") {
      return [
        {
          type: "tool_result",
          name: content.name ?? content.tool_name ?? "tool",
          output: typeof content.output === "string" ? content.output : safeString(content.output ?? content.result ?? content),
        },
      ];
    }

    if (contentType === "bash" || contentType === "shell" || contentType === "command") {
      return [
        {
          type: "bash",
          command: content.command ?? content.cmd ?? "",
          output: content.output ?? content.result ?? "",
        },
      ];
    }

    if (contentType === "error") {
      return [{ type: "error", text: content.message ?? content.error ?? safeString(content) }];
    }

    if ("tool_calls" in content && Array.isArray(content.tool_calls)) {
      return content.tool_calls.map(normalizeToolCall);
    }

    if ("text" in content) {
      return [{ type: "text", text: content.text ?? "" }];
    }

    if ("thinking" in content) {
      return [{ type: "thinking", text: content.thinking ?? "" }];
    }

    return [{ type: "text", text: safeString(content) }];
  }

  return [{ type: "text", text: safeString(content) }];
}

function formatModel(model) {
  if (!model) {
    return "";
  }
  if (typeof model === "string") {
    return model;
  }
  const provider = model.provider ?? model.vendor ?? "";
  const modelId = model.modelId ?? model.id ?? model.name ?? "";
  if (provider && modelId) {
    return `${provider}/${modelId}`;
  }
  return modelId || provider || safeString(model);
}

function formatUsage(usage, model) {
  if (!usage && !model) {
    return "";
  }

  const usageObj = usage ?? {};
  const input = Number(usageObj.input ?? usageObj.promptTokens ?? usageObj.inputTokens ?? 0);
  const output = Number(usageObj.output ?? usageObj.completionTokens ?? usageObj.outputTokens ?? 0);
  const totalTokens = Number(
    usageObj.totalTokens ??
      usageObj.total ??
      usageObj.total_tokens ??
      usageObj.tokens ??
      (input || output ? input + output : 0)
  );
  const cacheRead = Number(usageObj.cacheRead ?? usageObj.cache_read ?? usageObj.cacheReadTokens ?? 0);
  const cacheWrite = Number(usageObj.cacheWrite ?? usageObj.cache_write ?? usageObj.cacheCreation ?? 0);
  const cost =
    usageObj.cost?.total ??
    usageObj.costTotal ??
    usageObj.totalCost ??
    usageObj.usd ??
    usageObj.cost ??
    null;

  const parts = [];
  if (model) {
    parts.push(`model: ${model}`);
  }
  if (totalTokens) {
    parts.push(`tokens: ${totalTokens}`);
  } else if (input || output) {
    parts.push(`tokens: ${input}/${output}`);
  }
  if (cacheRead || cacheWrite) {
    parts.push(`cache: ${cacheRead}/${cacheWrite}`);
  }
  if (cost != null && cost !== "" && Number.isFinite(Number(cost))) {
    parts.push(`cost: $${Number(cost).toFixed(4)}`);
  }
  return parts.join(" · ");
}

function formatTimestamp(value) {
  if (!value) {
    return "";
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return String(value);
  }
  return parsed.toLocaleString();
}

function formatTimestampShort(value) {
  if (!value) {
    return "";
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return String(value);
  }
  const now = new Date();
  const diffMs = now - parsed;
  const diffMin = Math.floor(diffMs / 60000);
  const diffHr = Math.floor(diffMs / 3600000);
  const diffDay = Math.floor(diffMs / 86400000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHr < 24) return `${diffHr}h ago`;
  if (diffDay < 7) return `${diffDay}d ago`;
  return parsed.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function renderMarkdown(text) {
  if (!text) {
    return "";
  }
  try {
    return marked.parse(text);
  } catch {
    return text.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
  }
}

function highlightCodeBlocks(root) {
  if (!root || typeof hljs === "undefined") {
    return;
  }
  root.querySelectorAll("pre code").forEach((block) => {
    hljs.highlightElement(block);
  });
}

function normalizeMessage(message) {
  const role = message.role ?? "assistant";
  const parts = normalizeParts(message.content ?? message);

  const normalizedParts = parts.map((part, index) => {
    if (part.type === "text") {
      const text = String(part.text ?? "");
      return {
        ...part,
        key: `${message.id}-text-${index}`,
        render: role === "assistant" ? "html" : "text",
        content: role === "assistant" ? renderMarkdown(text) : text,
      };
    }
    if (part.type === "thinking") {
      const thinkingText = String(part.text ?? "");
      return {
        ...part,
        key: `${message.id}-thinking-${index}`,
        content: renderMarkdown(thinkingText),
        preview: generateOutputPreview(thinkingText, 100),
      };
    }
    if (part.type === "tool_call") {
      const args = typeof part.args === "string" ? part.args : safeString(part.args ?? "");
      const output = typeof part.output === "string" ? part.output : safeString(part.output ?? "");
      return {
        ...part,
        key: `${message.id}-tool-${index}`,
        args,
        argsSummary: part.argsSummary ?? clampString(args, 120),
        output,
        outputPreview: part.outputPreview ?? generateOutputPreview(output),
        status: part.status ?? "done",
        duration: part.duration ?? "",
      };
    }
    if (part.type === "bash") {
      return {
        ...part,
        key: `${message.id}-bash-${index}`,
        command: part.command ?? "",
        output: part.output ?? "",
      };
    }
    if (part.type === "compaction" || part.type === "summary" || part.type === "retry") {
      return {
        ...part,
        key: `${message.id}-summary-${index}`,
      };
    }
    if (part.type === "error") {
      return {
        ...part,
        key: `${message.id}-error-${index}`,
      };
    }
    return {
      ...part,
      key: `${message.id}-part-${index}`,
    };
  });

  return {
    id: message.id,
    role,
    roleLabel: role === "assistant" ? "assistant" : role,
    timestamp: formatTimestamp(message.timestamp ?? ""),
    parts: normalizedParts,
    usageLine: role === "assistant" ? formatUsage(message.usage, formatModel(message.model)) : "",
    canFork: role === "user",
  };
}

function buildWsUrl() {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/ws`;
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error ?? `Request failed (${response.status})`);
  }
  return response.json();
}

async function postJson(url, payload) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(payload ?? {}),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error ?? `Request failed (${response.status})`);
  }
  return data;
}

function toIsoTimestamp(value) {
  if (typeof value === "number") {
    return new Date(value).toISOString();
  }
  if (typeof value === "string") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString();
    }
  }
  return new Date().toISOString();
}

function findToolCallInMessage(message, contentIndex) {
  const content = message?.content;
  if (!Array.isArray(content)) {
    return null;
  }
  const block = content[Number(contentIndex)];
  if (block && typeof block === "object" && block.type === "toolCall") {
    return block;
  }
  return null;
}

function extractToolOutput(result) {
  if (!result) {
    return "";
  }
  if (typeof result === "string") {
    return result;
  }

  const textFromContent = Array.isArray(result.content)
    ? result.content
        .map((item) => {
          if (!item || typeof item !== "object") {
            return "";
          }
          if (item.type === "text") {
            return String(item.text ?? "");
          }
          return safeString(item);
        })
        .filter(Boolean)
        .join("\n")
    : "";

  if (textFromContent) {
    return textFromContent;
  }

  if (result.details != null) {
    return safeString(result.details);
  }

  return safeString(result);
}

const THINKING_LEVELS = ["none", "low", "medium", "high"];

// Toast notification levels
const TOAST_LEVELS = {
  info: { color: "var(--cyan)", icon: "ℹ" },
  success: { color: "var(--green)", icon: "✓" },
  warning: { color: "var(--yellow)", icon: "⚠" },
  error: { color: "var(--red)", icon: "✕" },
};

// Default toast duration
const TOAST_DEFAULT_DURATION = 5000;

function isMobileViewport() {
  return window.innerWidth <= 720;
}

document.addEventListener("alpine:init", () => {
  Alpine.data("rhoChat", () => ({
    sessions: [],
    activeSessionId: "",
    activeSession: null,
    renderedMessages: [],
    isLoadingSessions: false,
    isLoadingSession: false,
    isForking: false,
    isSendingPrompt: false,
    error: "",
    poller: null,
    ws: null,
    activeRpcSessionId: "",
    activeRpcSessionFile: "",
    promptText: "",
    streamMessageId: "",
    markdownRenderQueue: new Map(),
    markdownFrame: null,
    toolCallPartById: new Map(),

    // Mobile collapsible panel state
    showSessionsPanel: true,

    // Maximized chat mode
    chatMaximized: false,

    toggleMaximized() {
      this.chatMaximized = !this.chatMaximized;
      document.body.classList.toggle("chat-maximized", this.chatMaximized);
    },

    enterMaximized() {
      if (!this.chatMaximized) {
        this.chatMaximized = true;
        document.body.classList.add("chat-maximized");
      }
    },

    exitMaximized() {
      if (this.chatMaximized) {
        this.chatMaximized = false;
        document.body.classList.remove("chat-maximized");
      }
    },

    // Auto-scroll state
    userScrolledUp: false,

    // Chat controls state
    availableModels: [],
    currentModel: null,
    currentThinkingLevel: "medium",
    isStreaming: false,
    sessionStats: { tokens: 0, cost: 0 },
    pendingModelChange: null,

    // Extension UI state
    extensionDialog: null,
    extensionWidget: null,
    extensionStatus: "",
    toasts: [],
    toastIdCounter: 0,

    // WebSocket reconnection state
    wsReconnectAttempts: 0,
    wsReconnectTimer: null,
    wsMaxReconnectDelay: 30000,
    wsBaseReconnectDelay: 1000,
    isWsConnected: false,
    showReconnectBanner: false,

    async init() {
      marked.setOptions({
        gfm: true,
        breaks: true,
      });
      this.connectWebSocket();
      await this.loadSessions();
      this.startPolling();
      this.setupKeyboardShortcuts();
    },

    setupKeyboardShortcuts() {
      document.addEventListener("keydown", (e) => {
        // Escape to close dialogs
        if (e.key === "Escape") {
          if (this.extensionDialog) {
            this.dismissDialog(null);
            e.preventDefault();
            return;
          }
        }
      });
    },

    handleComposerKeydown(e) {
      // Enter to send (without shift)
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        this.handlePromptSubmit();
      }
    },

    handleComposerInput(event) {
      const el = event.target;
      el.style.height = 'auto';
      el.style.height = Math.min(el.scrollHeight, 200) + 'px';
    },

    handleThreadScroll() {
      const el = this.$refs.thread;
      if (!el) return;
      this.userScrolledUp = el.scrollTop + el.clientHeight < el.scrollHeight - 50;
    },

    connectWebSocket() {
      if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
        return;
      }

      // Clear any pending reconnect timer
      if (this.wsReconnectTimer) {
        clearTimeout(this.wsReconnectTimer);
        this.wsReconnectTimer = null;
      }

      const ws = new WebSocket(buildWsUrl());

      ws.addEventListener("open", () => {
        this.isWsConnected = true;
        this.showReconnectBanner = false;
        this.wsReconnectAttempts = 0;
        this.error = "";
      });

      ws.addEventListener("message", (event) => {
        this.handleWsMessage(event);
      });

      ws.addEventListener("close", () => {
        if (this.ws === ws) {
          this.ws = null;
          this.isWsConnected = false;
          this.scheduleReconnect();
        }
      });

      ws.addEventListener("error", () => {
        this.isWsConnected = false;
        // Error handling is done in close event
      });

      this.ws = ws;
    },

    scheduleReconnect() {
      this.wsReconnectAttempts++;
      this.showReconnectBanner = true;

      // Exponential backoff: 1s, 2s, 4s, 8s, 16s, max 30s
      const delay = Math.min(
        this.wsBaseReconnectDelay * Math.pow(2, this.wsReconnectAttempts - 1),
        this.wsMaxReconnectDelay
      );

      this.wsReconnectTimer = setTimeout(() => {
        this.connectWebSocket();
      }, delay);
    },

    manualReconnect() {
      this.wsReconnectAttempts = 0;
      if (this.wsReconnectTimer) {
        clearTimeout(this.wsReconnectTimer);
        this.wsReconnectTimer = null;
      }
      this.connectWebSocket();
    },

    sendWs(payload) {
      if (!this.ws) {
        this.error = "WebSocket not connected";
        return false;
      }

      if (this.ws.readyState === WebSocket.CONNECTING) {
        this.ws.addEventListener(
          "open",
          () => {
            this.ws?.send(JSON.stringify(payload));
          },
          { once: true }
        );
        return true;
      }

      if (this.ws.readyState !== WebSocket.OPEN) {
        this.error = "WebSocket not connected";
        return false;
      }

      this.ws.send(JSON.stringify(payload));
      return true;
    },

    handleWsMessage(event) {
      let payload = null;
      try {
        payload = JSON.parse(event.data);
      } catch {
        return;
      }

      if (!payload || typeof payload !== "object") {
        return;
      }

      if (payload.type === "error") {
        this.error = payload.message ?? "WebSocket error";
        this.isForking = false;
        this.isSendingPrompt = false;
        return;
      }

      if (payload.type === "session_started") {
        this.activeRpcSessionId = payload.sessionId ?? "";
        this.activeRpcSessionFile = payload.sessionFile ?? "";
        this.isForking = false;
        // Fetch initial state and available models
        this.requestState();
        this.requestAvailableModels();
        this.requestSessionStats();
        return;
      }

      if (payload.type !== "rpc_event") {
        return;
      }

      if (!payload.sessionId || payload.sessionId !== this.activeRpcSessionId) {
        return;
      }

      const rpcEvent = payload.event;
      if (!rpcEvent || typeof rpcEvent !== "object") {
        return;
      }

      this.handleRpcEvent(rpcEvent);
    },

    handleRpcEvent(event) {
      if (event.type === "response") {
        if (!event.success) {
          this.error = event.error ?? `RPC command failed: ${event.command ?? "unknown"}`;
          this.isSendingPrompt = false;
        }
        // Handle get_state response
        if (event.command === "get_state" && event.success) {
          const state = event.state ?? event.data ?? {};
          this.handleStateUpdate(state);
        }
        // Handle get_available_models response
        if (event.command === "get_available_models" && event.success) {
          const models = event.models ?? event.data?.models ?? [];
          this.availableModels = models;
        }
        // Handle get_session_stats response
        if (event.command === "get_session_stats" && event.success) {
          const stats = event.stats ?? event.data ?? {};
          this.handleSessionStatsUpdate(stats);
        }
        return;
      }

      if (event.type === "agent_start") {
        this.isStreaming = true;
        this.updateFooter();
        return;
      }

      if (event.type === "agent_end") {
        this.isStreaming = false;
        this.isSendingPrompt = false;
        this.updateFooter();
        // Refresh stats after agent completes
        this.requestSessionStats();
        return;
      }

      if (event.type === "state_changed" || event.type === "state_update") {
        if (event.state) {
          this.handleStateUpdate(event.state);
        }
        return;
      }

      if (event.type === "model_changed") {
        if (event.model) {
          this.currentModel = event.model;
        }
        this.updateFooter();
        return;
      }

      if (event.type === "thinking_level_changed") {
        if (event.thinkingLevel) {
          this.currentThinkingLevel = event.thinkingLevel;
        }
        this.updateFooter();
        return;
      }

      if (event.type === "message_start") {
        this.upsertMessage(event.message);
        return;
      }

      if (event.type === "message_update") {
        this.handleAssistantDelta(event);
        return;
      }

      if (event.type === "tool_execution_start") {
        this.handleToolExecutionStart(event);
        return;
      }

      if (event.type === "tool_execution_update") {
        this.handleToolExecutionUpdate(event);
        return;
      }

      if (event.type === "tool_execution_end") {
        this.handleToolExecutionEnd(event);
        return;
      }

      if (event.type === "message_end") {
        this.handleMessageEnd(event);
        return;
      }

      if (event.type === "auto_compaction_start") {
        this.appendBanner("compaction", `Compaction started (${event.reason ?? "threshold"})`);
        return;
      }

      if (event.type === "auto_compaction_end") {
        const summary = event.result?.summary ?? event.errorMessage ?? (event.aborted ? "Compaction aborted" : "Compaction complete");
        this.appendBanner("compaction", summary);
        return;
      }

      if (event.type === "auto_retry_start") {
        const attempt = Number(event.attempt ?? 0);
        const maxAttempts = Number(event.maxAttempts ?? 0);
        const line = `Retry ${attempt}/${maxAttempts} in ${Math.round(Number(event.delayMs ?? 0) / 1000)}s`;
        this.appendBanner("retry", line);
        return;
      }

      if (event.type === "auto_retry_end") {
        const status = event.success ? "Retry succeeded" : `Retry failed: ${event.finalError ?? "unknown error"}`;
        this.appendBanner("retry", status);
        return;
      }

      if (event.type === "extension_error") {
        const line = `${event.extensionPath ?? "extension"}: ${event.error ?? "unknown error"}`;
        this.appendBanner("error", line);
        return;
      }

      if (event.type === "rpc_error" || event.type === "rpc_process_crashed") {
        this.error = event.message ?? "RPC process error";
        this.isSendingPrompt = false;
        return;
      }

      // Extension UI events
      if (event.type === "extension_ui_request") {
        this.handleExtensionUIRequest(event);
        return;
      }

      // Fire-and-forget extension events
      if (event.type === "notify" || event.type === "extension_notify") {
        this.showToast(event.message ?? event.text ?? "", event.level ?? "info", event.duration);
        return;
      }

      if (event.type === "setStatus" || event.type === "extension_status") {
        this.extensionStatus = event.text ?? event.message ?? "";
        this.updateFooter();
        return;
      }

      if (event.type === "setWidget" || event.type === "extension_widget") {
        this.extensionWidget = event.widget ?? event.content ?? null;
        return;
      }

      if (event.type === "setTitle" || event.type === "extension_title") {
        const title = event.title ?? event.text ?? "";
        if (title) {
          document.title = `${title} - Rho Web UI`;
        } else {
          document.title = "Rho Web UI";
        }
        return;
      }
    },

    upsertMessage(rawMessage) {
      if (!rawMessage || typeof rawMessage !== "object") {
        return;
      }

      const messageId = String(rawMessage.id ?? "");
      if (!messageId) {
        return;
      }

      const role = String(rawMessage.role ?? "");
      if (role === "assistant") {
        return;
      }

      const normalized = normalizeMessage({ ...rawMessage, id: messageId, timestamp: toIsoTimestamp(rawMessage.timestamp) });

      // Skip empty messages
      if (!normalized.parts || normalized.parts.length === 0) {
        return;
      }
      const hasContent = normalized.parts.some((p) => {
        if (p.type === 'text') return Boolean(p.content);
        if (p.type === 'thinking') return Boolean(p.content);
        if (p.type === 'tool_call') return Boolean(p.name || p.args);
        if (p.type === 'tool_result') return Boolean(p.output);
        if (p.type === 'bash') return Boolean(p.command || p.output);
        if (p.type === 'error') return Boolean(p.text);
        if (p.type === 'compaction' || p.type === 'summary' || p.type === 'retry') return Boolean(p.summary);
        return true;
      });
      if (!hasContent) {
        return;
      }

      const idx = this.renderedMessages.findIndex((item) => item.id === messageId);
      if (idx >= 0) {
        this.renderedMessages[idx] = normalized;
      } else {
        this.renderedMessages.push(normalized);
      }

      this.$nextTick(() => {
        highlightCodeBlocks(this.$refs.thread);
        this.scrollThreadToBottom();
      });
    },

    ensureStreamingMessage(eventMessage) {
      const eventId = String(eventMessage?.id ?? "");
      const messageId = eventId || this.streamMessageId || `stream-${Date.now()}`;
      this.streamMessageId = messageId;

      let message = this.renderedMessages.find((item) => item.id === messageId);
      if (!message) {
        const normalized = normalizeMessage({
          id: messageId,
          role: "assistant",
          timestamp: toIsoTimestamp(eventMessage?.timestamp),
          content: "",
          model: eventMessage?.model,
        });
        message = {
          ...normalized,
          stream: {
            textBuffers: {},
            thinkingBuffers: {},
            toolCallBuffers: {},
          },
        };
        this.renderedMessages.push(message);
      }

      if (!message.stream) {
        message.stream = {
          textBuffers: {},
          thinkingBuffers: {},
          toolCallBuffers: {},
        };
      }

      return message;
    },

    ensurePart(message, key, createPart) {
      const idx = message.parts.findIndex((part) => part.key === key);
      if (idx >= 0) {
        return message.parts[idx];
      }
      const next = createPart();
      message.parts.push(next);
      return next;
    },

    scheduleMarkdownRender(messageId, contentIndex) {
      const key = String(contentIndex);
      if (!this.markdownRenderQueue.has(messageId)) {
        this.markdownRenderQueue.set(messageId, new Set());
      }
      this.markdownRenderQueue.get(messageId).add(key);

      if (this.markdownFrame != null) {
        return;
      }

      this.markdownFrame = window.requestAnimationFrame(() => {
        this.flushMarkdownRender();
      });
    },

    flushMarkdownRender() {
      this.markdownFrame = null;

      for (const [messageId, indexes] of this.markdownRenderQueue.entries()) {
        const message = this.renderedMessages.find((item) => item.id === messageId);
        if (!message?.stream) {
          continue;
        }

        for (const index of indexes) {
          const text = message.stream.textBuffers[index] ?? "";
          const partKey = `${messageId}-stream-text-${index}`;
          const part = this.ensurePart(message, partKey, () => ({
            type: "text",
            key: partKey,
            render: "html",
            content: "",
          }));
          part.render = "html";
          part.content = renderMarkdown(text);
        }
      }

      this.markdownRenderQueue.clear();

      this.$nextTick(() => {
        highlightCodeBlocks(this.$refs.thread);
        this.scrollThreadToBottom();
      });
    },

    handleAssistantDelta(event) {
      const message = this.ensureStreamingMessage(event.message);
      const delta = event.assistantMessageEvent ?? {};
      const deltaType = delta.type;
      const contentIndex = String(delta.contentIndex ?? 0);

      if (deltaType === "text_start") {
        message.stream.textBuffers[contentIndex] = "";
        this.scheduleMarkdownRender(message.id, contentIndex);
        return;
      }

      if (deltaType === "text_delta") {
        message.stream.textBuffers[contentIndex] = (message.stream.textBuffers[contentIndex] ?? "") + String(delta.delta ?? "");
        this.scheduleMarkdownRender(message.id, contentIndex);
        return;
      }

      if (deltaType === "text_end") {
        if (typeof delta.content === "string") {
          message.stream.textBuffers[contentIndex] = delta.content;
        }
        this.scheduleMarkdownRender(message.id, contentIndex);
        return;
      }

      if (deltaType === "thinking_start") {
        message.stream.thinkingBuffers[contentIndex] = "";
        const key = `${message.id}-stream-thinking-${contentIndex}`;
        this.ensurePart(message, key, () => ({
          type: "thinking",
          key,
          content: "",
        }));
        this.scrollThreadToBottom();
        return;
      }

      if (deltaType === "thinking_delta" || deltaType === "thinking_end") {
        const nextText =
          deltaType === "thinking_end" && typeof delta.content === "string"
            ? delta.content
            : (message.stream.thinkingBuffers[contentIndex] ?? "") + String(delta.delta ?? "");
        message.stream.thinkingBuffers[contentIndex] = nextText;

        const key = `${message.id}-stream-thinking-${contentIndex}`;
        const part = this.ensurePart(message, key, () => ({
          type: "thinking",
          key,
          content: "",
        }));
        part.content = renderMarkdown(nextText);

        this.$nextTick(() => {
          highlightCodeBlocks(this.$refs.thread);
          this.scrollThreadToBottom();
        });
        return;
      }

      if (deltaType === "toolcall_start") {
        message.stream.toolCallBuffers[contentIndex] = "";
        const key = `${message.id}-stream-tool-${contentIndex}`;
        this.ensurePart(message, key, () => ({
          type: "tool_call",
          key,
          name: "tool",
          args: "",
          argsSummary: "",
          output: "",
          outputPreview: "",
          status: "running",
          duration: "",
          startTime: Date.now(),
        }));
        return;
      }

      if (deltaType === "toolcall_delta" || deltaType === "toolcall_end") {
        const chunk = String(delta.delta ?? "");
        message.stream.toolCallBuffers[contentIndex] = (message.stream.toolCallBuffers[contentIndex] ?? "") + chunk;

        const key = `${message.id}-stream-tool-${contentIndex}`;
        const part = this.ensurePart(message, key, () => ({
          type: "tool_call",
          key,
          name: "tool",
          args: "",
          argsSummary: "",
          output: "",
          outputPreview: "",
          status: "running",
          duration: "",
          startTime: Date.now(),
        }));

        const fullToolCall =
          delta.toolCall ??
          delta.partial?.content?.[Number(contentIndex)] ??
          findToolCallInMessage(event.message, contentIndex);

        const argsText = fullToolCall?.arguments ? safeString(fullToolCall.arguments) : message.stream.toolCallBuffers[contentIndex] ?? "";

        part.name = fullToolCall?.name ?? part.name ?? "tool";
        part.toolCallId = fullToolCall?.id ?? part.toolCallId;
        part.args = argsText;
        part.argsSummary = clampString(argsText.replace(/\s+/g, " ").trim(), 120);
        part.status = deltaType === "toolcall_end" ? "done" : "running";

        if (part.toolCallId) {
          this.toolCallPartById.set(part.toolCallId, { messageId: message.id, key });
        }

        this.scrollThreadToBottom();
      }
    },

    handleToolExecutionStart(event) {
      const message = this.ensureStreamingMessage({ id: this.streamMessageId });
      const toolCallId = String(event.toolCallId ?? `tool-${Date.now()}`);
      const key = `${message.id}-tool-exec-${toolCallId}`;
      const argsText = safeString(event.args ?? "");
      const part = this.ensurePart(message, key, () => ({
        type: "tool_call",
        key,
        name: event.toolName ?? "tool",
        args: argsText,
        argsSummary: clampString(argsText.replace(/\s+/g, " ").trim(), 120),
        output: "",
        outputPreview: "",
        status: "running",
        toolCallId,
        duration: "",
        startTime: Date.now(),
      }));

      part.name = event.toolName ?? part.name ?? "tool";
      part.args = argsText;
      part.argsSummary = clampString(argsText.replace(/\s+/g, " ").trim(), 120);
      part.status = "running";
      part.toolCallId = toolCallId;
      part.startTime = Date.now();

      this.toolCallPartById.set(toolCallId, { messageId: message.id, key });
      this.scrollThreadToBottom();
    },

    findToolCallPart(toolCallId) {
      const ref = this.toolCallPartById.get(toolCallId);
      if (!ref) {
        return null;
      }
      const message = this.renderedMessages.find((item) => item.id === ref.messageId);
      if (!message) {
        return null;
      }
      return message.parts.find((part) => part.key === ref.key) ?? null;
    },

    handleToolExecutionUpdate(event) {
      const toolCallId = String(event.toolCallId ?? "");
      if (!toolCallId) {
        return;
      }

      let part = this.findToolCallPart(toolCallId);
      if (!part) {
        this.handleToolExecutionStart(event);
        part = this.findToolCallPart(toolCallId);
      }
      if (!part) {
        return;
      }

      part.status = "running";
      const output = extractToolOutput(event.partialResult);
      part.output = output;
      part.outputPreview = generateOutputPreview(output);
      this.scrollThreadToBottom();
    },

    handleToolExecutionEnd(event) {
      const toolCallId = String(event.toolCallId ?? "");
      if (!toolCallId) {
        return;
      }

      let part = this.findToolCallPart(toolCallId);
      if (!part) {
        this.handleToolExecutionStart(event);
        part = this.findToolCallPart(toolCallId);
      }
      if (!part) {
        return;
      }

      part.status = event.isError ? "error" : "done";
      const output = extractToolOutput(event.result);
      part.output = output;
      part.outputPreview = generateOutputPreview(output);

      // Calculate duration
      if (part.startTime) {
        const elapsed = Date.now() - part.startTime;
        if (elapsed >= 1000) {
          part.duration = `${(elapsed / 1000).toFixed(1)}s`;
        } else {
          part.duration = `${elapsed}ms`;
        }
      }

      this.scrollThreadToBottom();
    },

    handleMessageEnd(event) {
      const message = event.message;
      const role = String(message?.role ?? "");
      const messageId = String(message?.id ?? this.streamMessageId ?? "");

      if (role === "assistant") {
        const finalMessage = normalizeMessage({
          ...(message ?? {}),
          id: messageId || `stream-${Date.now()}`,
          timestamp: toIsoTimestamp(message?.timestamp),
        });

        const idx = this.renderedMessages.findIndex((item) => item.id === finalMessage.id || item.id === this.streamMessageId);
        if (idx >= 0) {
          this.renderedMessages[idx] = finalMessage;
        } else {
          this.renderedMessages.push(finalMessage);
        }

        this.streamMessageId = "";
        this.isSendingPrompt = false;
        this.$nextTick(() => {
          highlightCodeBlocks(this.$refs.thread);
          this.scrollThreadToBottom();
        });
        this.loadSessions(false);
        return;
      }

      this.upsertMessage(message);
    },

    appendBanner(type, text) {
      const partType = type === "error" ? "error" : type === "retry" ? "retry" : "compaction";
      const message = {
        id: `banner-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`,
        role: partType === "error" ? "error" : "summary",
        roleLabel: partType === "error" ? "error" : "system",
        timestamp: formatTimestamp(new Date().toISOString()),
        parts: [
          partType === "error"
            ? { type: "error", key: `banner-${Date.now()}`, text }
            : partType === "retry"
              ? { type: "retry", key: `banner-${Date.now()}`, summary: text }
              : { type: "compaction", key: `banner-${Date.now()}`, summary: text },
        ],
        usageLine: "",
        canFork: false,
      };

      this.renderedMessages.push(message);
      this.scrollThreadToBottom();
    },

    scrollThreadToBottom() {
      if (this.userScrolledUp) return;
      const thread = this.$refs.thread;
      if (!thread) {
        return;
      }
      thread.scrollTop = thread.scrollHeight;
    },

    startPolling() {
      this.stopPolling();
      this.poller = setInterval(() => {
        this.loadSessions(false);
      }, CHAT_REFRESH_INTERVAL);
    },

    stopPolling() {
      if (this.poller) {
        clearInterval(this.poller);
        this.poller = null;
      }
    },

    sessionsTotal: 0,
    sessionsLoaded: 0,
    sessionsPageSize: 20,
    isLoadingMore: false,
    allSessionsLoaded: false,

    async loadSessions(showSpinner = true) {
      if (showSpinner) {
        this.isLoadingSessions = true;
      }
      this.error = "";

      try {
        const resp = await fetch(`/api/sessions?limit=${this.sessionsPageSize}&offset=0`);
        const total = parseInt(resp.headers.get("X-Total-Count") ?? "0", 10);
        const sessions = await resp.json();
        this.sessions = sessions;
        this.sessionsTotal = total;
        this.sessionsLoaded = sessions.length;
        this.allSessionsLoaded = sessions.length >= total;

        if (!this.activeSessionId && sessions.length > 0) {
          await this.selectSession(sessions[0].id);
        }
      } catch (error) {
        this.error = error.message ?? "Failed to load sessions";
      } finally {
        this.isLoadingSessions = false;
      }
    },

    async loadMoreSessions() {
      if (this.isLoadingMore || this.allSessionsLoaded) return;
      this.isLoadingMore = true;
      try {
        const resp = await fetch(`/api/sessions?limit=${this.sessionsPageSize}&offset=${this.sessionsLoaded}`);
        const more = await resp.json();
        if (more.length === 0) {
          this.allSessionsLoaded = true;
        } else {
          // Deduplicate by ID
          const existingIds = new Set(this.sessions.map(s => s.id));
          const newSessions = more.filter(s => !existingIds.has(s.id));
          this.sessions = [...this.sessions, ...newSessions];
          this.sessionsLoaded += more.length;
          this.allSessionsLoaded = this.sessionsLoaded >= this.sessionsTotal;
        }
      } catch (error) {
        // Silent fail on load-more
      } finally {
        this.isLoadingMore = false;
      }
    },

    onSessionsScroll(event) {
      const el = event.target;
      if (el.scrollTop + el.clientHeight >= el.scrollHeight - 50) {
        this.loadMoreSessions();
      }
    },

    async reloadActiveSession() {
      if (!this.activeSessionId) {
        return;
      }
      await this.selectSession(this.activeSessionId);
    },

    toggleSessionsPanel() {
      this.showSessionsPanel = !this.showSessionsPanel;
    },

    async selectSession(sessionId) {
      if (!sessionId) {
        return;
      }

      this.activeSessionId = sessionId;
      this.isLoadingSession = true;
      this.error = "";
      this.streamMessageId = "";
      this.toolCallPartById.clear();

      // Auto-collapse sessions panel on mobile after selection
      if (isMobileViewport()) {
        this.showSessionsPanel = false;
      }

      try {
        const session = await fetchJson(`/api/sessions/${sessionId}`);
        this.applySession(session);
      } catch (error) {
        this.error = error.message ?? "Failed to load session";
      } finally {
        this.isLoadingSession = false;
      }
    },

    applySession(session) {
      this.activeSession = session;

      // Merge toolResult messages into preceding assistant's tool_call parts
      const rawMessages = session.messages ?? [];
      const mergedMessages = [];
      for (let i = 0; i < rawMessages.length; i++) {
        const msg = rawMessages[i];
        if (msg.role === "toolResult" || msg.role === "tool_result" || msg.role === "tool") {
          // Find the last assistant message and merge this result into its tool_call parts
          for (let j = mergedMessages.length - 1; j >= 0; j--) {
            if (mergedMessages[j].role === "assistant") {
              const content = mergedMessages[j].content;
              if (Array.isArray(content)) {
                // Find first tool_call without merged output
                const call = content.find(
                  (c) => (c.type === "toolCall" || c.type === "tool_call" || c.type === "tool_use") && !c._merged
                );
                if (call) {
                  const resultText = Array.isArray(msg.content)
                    ? msg.content.map((c) => c.text ?? c.output ?? "").join("\n")
                    : typeof msg.content === "string" ? msg.content : "";
                  call.output = resultText;
                  call._merged = true;
                }
              }
              break;
            }
          }
          continue; // Don't add toolResult as a separate message
        }
        mergedMessages.push({ ...msg });
      }

      // Normalize messages, filter empty ones, and deduplicate by ID
      const seenIds = new Set();
      this.renderedMessages = mergedMessages
        .map(normalizeMessage)
        .filter((msg) => {
          // Skip empty messages (no parts or all parts empty)
          if (!msg.parts || msg.parts.length === 0) {
            return false;
          }
          const hasContent = msg.parts.some((p) => {
            if (p.type === 'text') return Boolean(p.content);
            if (p.type === 'thinking') return Boolean(p.content);
            if (p.type === 'tool_call') return Boolean(p.name || p.args);
            if (p.type === 'tool_result') return Boolean(p.output);
            if (p.type === 'bash') return Boolean(p.command || p.output);
            if (p.type === 'error') return Boolean(p.text);
            if (p.type === 'compaction' || p.type === 'summary' || p.type === 'retry') return Boolean(p.summary);
            return true; // Unknown part types pass through
          });
          if (!hasContent) {
            return false;
          }
          // Deduplicate by ID
          if (seenIds.has(msg.id)) {
            return false;
          }
          seenIds.add(msg.id);
          return true;
        });

      this.$nextTick(() => {
        highlightCodeBlocks(this.$refs.thread);
      });
    },

    sessionLabel(session) {
      if (!session) {
        return "";
      }
      // Show session name, first prompt, or truncated ID
      const rawId = session.header?.id ?? session.id ?? "";
      const firstPrompt = session.firstPrompt;
      const title = session.name || (firstPrompt ? clampString(firstPrompt, 50) : (rawId ? rawId.substring(0, 8) : "session"));
      const timestamp = formatTimestamp(session.header?.timestamp ?? session.timestamp);
      return `${title}${timestamp ? ` · ${timestamp}` : ""}`;
    },

    messageCountLabel(session) {
      if (!session) {
        return "";
      }
      const count = session.messageCount ?? session.messages?.length ?? 0;
      return `${count} message${count === 1 ? "" : "s"}`;
    },

    formatTimestamp(value) {
      return formatTimestamp(value);
    },

    hasMessages() {
      return this.renderedMessages.length > 0;
    },

    latestForkPointId() {
      return this.activeSession?.forkPoints?.at?.(-1)?.id ?? "";
    },

    hasForkPoints() {
      return Boolean(this.latestForkPointId());
    },

    isForkActive() {
      return Boolean(this.activeRpcSessionId);
    },

    sessionForkBadge(session) {
      if (!session?.parentSession) {
        return "";
      }
      return "fork";
    },

    sessionForkTitle(session) {
      return session?.parentSession ? `forked from ${session.parentSession}` : "";
    },

    canForkMessage(message) {
      return Boolean(message?.canFork && this.activeSessionId);
    },

    async newSession() {
      if (this.isForking) return;
      this.error = "";
      this.isForking = true;

      try {
        const result = await postJson("/api/sessions/new", {});
        this.activeSessionId = result.sessionId;
        this.activeRpcSessionId = "";
        this.activeRpcSessionFile = result.sessionFile;
        this.promptText = "";
        this.renderedMessages = [];
        this.applySession(result.session);
        await this.loadSessions(false);
        this.startRpcSession(result.sessionFile);
        this.enterMaximized();
      } catch (error) {
        this.error = error.message ?? "Failed to create session";
        this.isForking = false;
      }
    },

    async forkFromLatest() {
      const entryId = this.latestForkPointId();
      if (!entryId) {
        this.error = "No user message available to fork from";
        return;
      }
      await this.forkFromEntry(entryId);
    },

    async forkFromEntry(entryId) {
      if (!this.activeSessionId || !entryId || this.isForking) {
        return;
      }

      this.error = "";
      this.isForking = true;

      try {
        const forkResult = await postJson(`/api/sessions/${this.activeSessionId}/fork`, { entryId });

        this.activeSessionId = forkResult.sessionId;
        this.activeRpcSessionId = "";
        this.activeRpcSessionFile = forkResult.sessionFile;
        this.promptText = "";

        this.applySession(forkResult.session);
        await this.loadSessions(false);
        this.startRpcSession(forkResult.sessionFile);
        this.enterMaximized();

        // Auto-scroll to bottom after fork
        this.$nextTick(() => {
          const thread = this.$refs.chatThread;
          if (thread) thread.scrollTop = thread.scrollHeight;
        });
      } catch (error) {
        this.error = error.message ?? "Failed to fork session";
        this.isForking = false;
      }
    },

    startRpcSession(sessionFile) {
      const sent = this.sendWs({
        type: "rpc_command",
        sessionFile,
        command: {
          type: "switch_session",
          sessionFile,
          sessionPath: sessionFile,
          path: sessionFile,
        },
      });

      if (!sent) {
        this.isForking = false;
      }
    },

    async sendPrompt() {
      const message = this.promptText.trim();
      if (!message || !this.activeRpcSessionId || this.isSendingPrompt) {
        return;
      }

      this.error = "";
      this.isSendingPrompt = true;
      this.promptText = "";
      this.streamMessageId = "";

      // Add user message locally before sending to RPC
      this.renderedMessages.push({
        id: `local-user-${Date.now()}`,
        role: 'user',
        roleLabel: 'USER',
        timestamp: new Date().toLocaleString(),
        parts: [{ type: 'text', render: 'text', content: message, key: `text-0` }],
        canFork: true,
      });
      this.scrollThreadToBottom();

      const sent = this.sendWs({
        type: "rpc_command",
        sessionId: this.activeRpcSessionId,
        command: {
          type: "prompt",
          message,
        },
      });

      if (!sent) {
        this.isSendingPrompt = false;
      } else {
        this.$nextTick(() => {
          this.scrollThreadToBottom();
        });
      }
    },

    messageForkPreview(message) {
      const firstText = message?.parts?.find((part) => part.type === "text");
      const text = firstText ? extractText(firstText.content ?? "") : "";
      return clampString(text.replace(/\s+/g, " ").trim(), 80) || "Fork from this prompt";
    },

    // Chat controls methods

    requestState() {
      if (!this.activeRpcSessionId) {
        return;
      }
      this.sendWs({
        type: "rpc_command",
        sessionId: this.activeRpcSessionId,
        command: { type: "get_state" },
      });
    },

    requestAvailableModels() {
      if (!this.activeRpcSessionId) {
        return;
      }
      this.sendWs({
        type: "rpc_command",
        sessionId: this.activeRpcSessionId,
        command: { type: "get_available_models" },
      });
    },

    requestSessionStats() {
      if (!this.activeRpcSessionId) {
        return;
      }
      this.sendWs({
        type: "rpc_command",
        sessionId: this.activeRpcSessionId,
        command: { type: "get_session_stats" },
      });
    },

    handleStateUpdate(state) {
      if (state.model) {
        this.currentModel = state.model;
      }
      if (state.thinkingLevel) {
        this.currentThinkingLevel = state.thinkingLevel;
      }
      if (typeof state.isStreaming === "boolean") {
        this.isStreaming = state.isStreaming;
      }
      this.updateFooter();
    },

    handleSessionStatsUpdate(stats) {
      this.sessionStats = {
        tokens: stats.totalTokens ?? stats.tokens ?? 0,
        cost: stats.totalCost ?? stats.cost ?? 0,
        inputTokens: stats.inputTokens ?? 0,
        outputTokens: stats.outputTokens ?? 0,
        cacheRead: stats.cacheRead ?? stats.cacheReadTokens ?? 0,
        cacheWrite: stats.cacheWrite ?? stats.cacheCreation ?? 0,
      };
      this.updateFooter();
    },

    currentModelLabel() {
      if (!this.currentModel) {
        return "--";
      }
      if (typeof this.currentModel === "string") {
        return this.currentModel;
      }
      const provider = this.currentModel.provider ?? "";
      const modelId = this.currentModel.modelId ?? this.currentModel.id ?? "";
      if (provider && modelId) {
        // Shorten common provider names
        const shortProvider = provider.replace("anthropic", "anth").replace("openai", "oai");
        return `${shortProvider}/${modelId}`;
      }
      return modelId || provider || "--";
    },

    modelDropdownLabel(model) {
      if (!model) {
        return "";
      }
      const provider = model.provider ?? "";
      const modelId = model.modelId ?? model.id ?? model.name ?? "";
      if (provider && modelId) {
        return `${provider}/${modelId}`;
      }
      return modelId || provider || "unknown";
    },

    isCurrentModel(model) {
      if (!this.currentModel || !model) {
        return false;
      }
      const currentId = this.currentModel.modelId ?? this.currentModel.id ?? this.currentModel;
      const checkId = model.modelId ?? model.id ?? model;
      const currentProvider = this.currentModel.provider ?? "";
      const checkProvider = model.provider ?? "";
      return currentId === checkId && currentProvider === checkProvider;
    },

    setModel(model) {
      if (!this.activeRpcSessionId || this.isStreaming) {
        return;
      }
      this.pendingModelChange = model;
      this.sendWs({
        type: "rpc_command",
        sessionId: this.activeRpcSessionId,
        command: {
          type: "set_model",
          provider: model.provider,
          modelId: model.modelId ?? model.id,
        },
      });
      // Optimistically update
      this.currentModel = model;
      this.updateFooter();
    },

    cycleThinkingLevel() {
      if (!this.activeRpcSessionId || this.isStreaming) {
        return;
      }
      const currentIndex = THINKING_LEVELS.indexOf(this.currentThinkingLevel);
      const nextIndex = (currentIndex + 1) % THINKING_LEVELS.length;
      const nextLevel = THINKING_LEVELS[nextIndex];

      this.sendWs({
        type: "rpc_command",
        sessionId: this.activeRpcSessionId,
        command: {
          type: "set_thinking_level",
          level: nextLevel,
        },
      });
      // Optimistically update
      this.currentThinkingLevel = nextLevel;
      this.updateFooter();
    },

    abort() {
      if (!this.activeRpcSessionId || !this.isStreaming) {
        return;
      }
      this.sendWs({
        type: "rpc_command",
        sessionId: this.activeRpcSessionId,
        command: { type: "abort" },
      });
    },

    sendSteer() {
      const message = this.promptText.trim();
      if (!message || !this.activeRpcSessionId || !this.isStreaming) {
        return;
      }

      this.error = "";
      this.promptText = "";

      this.sendWs({
        type: "rpc_command",
        sessionId: this.activeRpcSessionId,
        command: {
          type: "steer",
          message,
        },
      });
    },

    sendFollowUp() {
      const message = this.promptText.trim();
      if (!message || !this.activeRpcSessionId || !this.isStreaming) {
        return;
      }

      this.error = "";
      this.promptText = "";

      this.sendWs({
        type: "rpc_command",
        sessionId: this.activeRpcSessionId,
        command: {
          type: "follow_up",
          message,
        },
      });
    },

    handlePromptSubmit() {
      if (this.isStreaming) {
        // During streaming, submit as steer
        this.sendSteer();
      } else {
        // Normal prompt submission
        this.sendPrompt();
      }
    },

    updateFooter() {
      const modelEl = document.querySelector(".footer .footer-model");
      const tokensEl = document.querySelector(".footer .footer-tokens");
      const costEl = document.querySelector(".footer .footer-cost");
      const statusEl = document.querySelector(".footer .footer-status");
      const extStatusEl = document.querySelector(".footer .footer-ext-status");

      if (modelEl) {
        modelEl.textContent = `model: ${this.currentModelLabel()}`;
      }
      if (tokensEl) {
        const tokens = this.sessionStats.tokens || 0;
        tokensEl.textContent = `tokens: ${tokens.toLocaleString()}`;
      }
      if (costEl) {
        const cost = this.sessionStats.cost || 0;
        costEl.textContent = `cost: $${cost.toFixed(4)}`;
      }
      if (statusEl) {
        statusEl.textContent = `status: ${this.isStreaming ? "streaming" : "idle"}`;
        statusEl.classList.toggle("streaming", this.isStreaming);
      }
      if (extStatusEl) {
        extStatusEl.textContent = this.extensionStatus || "";
        extStatusEl.style.display = this.extensionStatus ? "inline" : "none";
      }
    },

    // Helper getters for template
    canSwitchModel() {
      return this.isForkActive() && !this.isStreaming;
    },

    canChangeThinking() {
      return this.isForkActive() && !this.isStreaming;
    },

    canAbort() {
      return this.isForkActive() && this.isStreaming;
    },

    thinkingLevelLabel() {
      return this.currentThinkingLevel || "medium";
    },

    inputPlaceholder() {
      if (!this.isForkActive()) {
        return "Fork a session to start chatting...";
      }
      if (this.isStreaming) {
        return "Type to steer the response...";
      }
      return "Type a prompt...";
    },

    submitButtonLabel() {
      if (this.isStreaming) {
        return "Steer";
      }
      return "Send";
    },

    // Extension UI methods

    handleExtensionUIRequest(event) {
      const request = event.request ?? event;
      const method = request.method ?? request.type ?? "";
      const id = request.id ?? `ext-${Date.now()}`;
      const timeout = request.timeout ?? request.timeoutMs ?? 0;

      if (method === "select") {
        this.showSelectDialog(id, request, timeout);
        return;
      }

      if (method === "confirm") {
        this.showConfirmDialog(id, request, timeout);
        return;
      }

      if (method === "input") {
        this.showInputDialog(id, request, timeout);
        return;
      }

      if (method === "editor") {
        this.showEditorDialog(id, request, timeout);
        return;
      }
    },

    showSelectDialog(id, request, timeout) {
      const options = request.options ?? request.choices ?? [];
      const title = request.title ?? request.message ?? "Select an option";
      const description = request.description ?? "";

      this.extensionDialog = {
        id,
        type: "select",
        title,
        description,
        options: options.map((opt, idx) => ({
          value: typeof opt === "string" ? opt : opt.value ?? opt.label ?? String(idx),
          label: typeof opt === "string" ? opt : opt.label ?? opt.value ?? String(idx),
          description: typeof opt === "object" ? opt.description ?? "" : "",
        })),
        selectedValue: null,
        timeoutId: null,
      };

      if (timeout > 0) {
        this.extensionDialog.timeoutId = setTimeout(() => {
          this.dismissDialog(null);
        }, timeout);
      }
    },

    showConfirmDialog(id, request, timeout) {
      const title = request.title ?? request.message ?? "Confirm";
      const description = request.description ?? request.text ?? "";
      const confirmLabel = request.confirmLabel ?? request.yesLabel ?? "Yes";
      const cancelLabel = request.cancelLabel ?? request.noLabel ?? "No";

      this.extensionDialog = {
        id,
        type: "confirm",
        title,
        description,
        confirmLabel,
        cancelLabel,
        timeoutId: null,
      };

      if (timeout > 0) {
        this.extensionDialog.timeoutId = setTimeout(() => {
          this.dismissDialog(false);
        }, timeout);
      }
    },

    showInputDialog(id, request, timeout) {
      const title = request.title ?? request.message ?? "Input";
      const description = request.description ?? "";
      const placeholder = request.placeholder ?? "";
      const defaultValue = request.defaultValue ?? request.value ?? "";

      this.extensionDialog = {
        id,
        type: "input",
        title,
        description,
        placeholder,
        inputValue: defaultValue,
        timeoutId: null,
      };

      if (timeout > 0) {
        this.extensionDialog.timeoutId = setTimeout(() => {
          this.dismissDialog(null);
        }, timeout);
      }
    },

    showEditorDialog(id, request, timeout) {
      const title = request.title ?? request.message ?? "Edit";
      const description = request.description ?? "";
      const content = request.content ?? request.value ?? request.text ?? "";
      const language = request.language ?? "";

      this.extensionDialog = {
        id,
        type: "editor",
        title,
        description,
        language,
        editorContent: content,
        timeoutId: null,
      };

      if (timeout > 0) {
        this.extensionDialog.timeoutId = setTimeout(() => {
          this.dismissDialog(null);
        }, timeout);
      }
    },

    selectDialogOption(option) {
      if (!this.extensionDialog || this.extensionDialog.type !== "select") {
        return;
      }
      this.sendExtensionUIResponse(this.extensionDialog.id, option.value);
      this.closeDialog();
    },

    confirmDialogYes() {
      if (!this.extensionDialog || this.extensionDialog.type !== "confirm") {
        return;
      }
      this.sendExtensionUIResponse(this.extensionDialog.id, true);
      this.closeDialog();
    },

    confirmDialogNo() {
      if (!this.extensionDialog || this.extensionDialog.type !== "confirm") {
        return;
      }
      this.sendExtensionUIResponse(this.extensionDialog.id, false);
      this.closeDialog();
    },

    submitInputDialog() {
      if (!this.extensionDialog || this.extensionDialog.type !== "input") {
        return;
      }
      this.sendExtensionUIResponse(this.extensionDialog.id, this.extensionDialog.inputValue);
      this.closeDialog();
    },

    submitEditorDialog() {
      if (!this.extensionDialog || this.extensionDialog.type !== "editor") {
        return;
      }
      this.sendExtensionUIResponse(this.extensionDialog.id, this.extensionDialog.editorContent);
      this.closeDialog();
    },

    dismissDialog(value = null) {
      if (!this.extensionDialog) {
        return;
      }
      this.sendExtensionUIResponse(this.extensionDialog.id, value);
      this.closeDialog();
    },

    closeDialog() {
      if (this.extensionDialog?.timeoutId) {
        clearTimeout(this.extensionDialog.timeoutId);
      }
      this.extensionDialog = null;
    },

    sendExtensionUIResponse(id, value) {
      if (!this.activeRpcSessionId) {
        return;
      }
      this.sendWs({
        type: "extension_ui_response",
        sessionId: this.activeRpcSessionId,
        id,
        value,
      });
    },

    // Toast notifications

    showToast(message, level = "info", duration) {
      const id = ++this.toastIdCounter;
      const toast = {
        id,
        message,
        level,
        style: TOAST_LEVELS[level] ?? TOAST_LEVELS.info,
      };

      this.toasts.push(toast);

      const displayDuration = duration ?? TOAST_DEFAULT_DURATION;
      if (displayDuration > 0) {
        setTimeout(() => {
          this.removeToast(id);
        }, displayDuration);
      }
    },

    removeToast(id) {
      const idx = this.toasts.findIndex((t) => t.id === id);
      if (idx >= 0) {
        this.toasts.splice(idx, 1);
      }
    },

    // Widget display
    hasWidget() {
      return this.extensionWidget != null;
    },

    widgetContent() {
      if (!this.extensionWidget) {
        return "";
      }
      if (typeof this.extensionWidget === "string") {
        return this.extensionWidget;
      }
      return this.extensionWidget.text ?? this.extensionWidget.content ?? safeString(this.extensionWidget);
    },

    // Focus management
    focusComposer() {
      this.$nextTick(() => {
        const input = this.$refs.composerInput;
        if (input && !input.disabled) {
          input.focus();
        }
      });
    },
  }));
});
