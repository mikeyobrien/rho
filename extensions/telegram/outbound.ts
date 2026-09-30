const MAX_TELEGRAM_TEXT = 4096;
const TELEGRAM_MARKDOWN_CHUNK_TARGET = 3400;

export interface TelegramOutboundChunk {
  text: string;
  parseMode?: "HTML";
  fallbackText: string;
}

export function renderOutboundText(text: string): string {
  return (text || "").trim() || "(empty response)";
}

export function chunkTelegramText(
  text: string,
  maxLen = MAX_TELEGRAM_TEXT,
): string[] {
  const normalized = renderOutboundText(text);
  if (normalized.length <= maxLen) return [normalized];

  const chunks: string[] = [];
  let rest = normalized;
  while (rest.length > maxLen) {
    let cut = rest.lastIndexOf("\n", maxLen);
    if (cut < Math.floor(maxLen * 0.4)) {
      cut = rest.lastIndexOf(" ", maxLen);
    }
    if (cut < Math.floor(maxLen * 0.4)) {
      cut = maxLen;
    }

    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trimStart();
  }
  if (rest.length > 0) chunks.push(rest);

  return chunks;
}

export function renderTelegramOutboundChunks(
  text: string,
  maxLen = MAX_TELEGRAM_TEXT,
): TelegramOutboundChunk[] {
  const normalized = renderOutboundText(text);
  const sourceChunks = chunkTelegramText(
    normalized,
    Math.min(maxLen, TELEGRAM_MARKDOWN_CHUNK_TARGET),
  );

  const outbound: TelegramOutboundChunk[] = [];
  for (const sourceChunk of sourceChunks) {
    const html = renderTelegramHtml(sourceChunk);
    if (html.length > 0 && html.length <= maxLen) {
      outbound.push({
        text: html,
        parseMode: "HTML",
        fallbackText: sourceChunk,
      });
      continue;
    }

    // Fallback for unusually tag-heavy chunks that exceed Telegram's limit after formatting.
    for (const plain of chunkTelegramText(sourceChunk, maxLen)) {
      outbound.push({ text: plain, fallbackText: plain });
    }
  }

  return outbound.length > 0
    ? outbound
    : [
        {
          text: normalized.slice(0, maxLen),
          fallbackText: normalized.slice(0, maxLen),
        },
      ];
}

function renderTelegramHtml(text: string): string {
  const lines = renderOutboundText(text).replace(/\r\n/g, "\n").split("\n");

  const out: string[] = [];
  let inCodeFence = false;
  const codeFenceLines: string[] = [];

  for (const line of lines) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith("```")) {
      if (inCodeFence) {
        out.push(
          `<pre><code>${escapeHtml(codeFenceLines.join("\n"))}</code></pre>`,
        );
        inCodeFence = false;
      } else {
        inCodeFence = true;
        codeFenceLines.length = 0;
      }
      continue;
    }

    if (inCodeFence) {
      codeFenceLines.push(line);
      continue;
    }

    const headingMatch = line.match(/^\s{0,3}#{1,6}\s+(.+)$/);
    if (headingMatch) {
      out.push(`<b>${formatInlineMarkdown(headingMatch[1].trim())}</b>`);
      continue;
    }

    out.push(formatInlineMarkdown(line));
  }

  if (inCodeFence) {
    out.push(
      `<pre><code>${escapeHtml(codeFenceLines.join("\n"))}</code></pre>`,
    );
  }

  return out.join("\n");
}

function formatInlineMarkdown(line: string): string {
  let escaped = escapeHtml(line);

  const codeTokens: string[] = [];
  escaped = escaped.replace(/`([^`\n]+)`/g, (_match, code: string) => {
    const token = `\u0000code${codeTokens.length}\u0000`;
    codeTokens.push(`<code>${code}</code>`);
    return token;
  });

  escaped = escaped.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    (_match, label: string, url: string) => {
      return `<a href="${url}">${label}</a>`;
    },
  );

  escaped = escaped.replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>");
  escaped = escaped.replace(/__([^_\n]+)__/g, "<b>$1</b>");

  escaped = escaped.replace(/\u0000code(\d+)\u0000/g, (_match, idx: string) => {
    return codeTokens[Number(idx)] ?? "";
  });

  return escaped;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
