import { Type } from "@sinclair/typebox";
import { resolveFiles } from "./files.ts";
import { formatReviewMessage } from "./format.ts";
import { startReviewServer } from "./server.ts";

/**
 * Parse a command argument string into individual tokens.
 * Supports double-quoted, single-quoted, and bare-word arguments.
 */
export function parseArgs(input: string): string[] {
  const args: string[] = [];
  let i = 0;
  const src = input.trim();

  while (i < src.length) {
    // skip whitespace
    while (i < src.length && src[i] === " ") i++;
    if (i >= src.length) break;

    const quote = src[i];
    if (quote === '"' || quote === "'") {
      // quoted token — collect until matching close quote
      i++; // skip opening quote
      let token = "";
      while (i < src.length && src[i] !== quote) {
        token += src[i];
        i++;
      }
      i++; // skip closing quote
      args.push(token);
    } else {
      // bare word — collect until whitespace
      let token = "";
      while (i < src.length && src[i] !== " ") {
        token += src[i];
        i++;
      }
      args.push(token);
    }
  }

  return args;
}

export default function reviewExtension(pi: any) {
  pi.registerTool({
    name: "review",
    description:
      "Open files for user review with line-level commenting. Returns formatted review comments or cancellation notice.",
    parameters: Type.Object({
      files: Type.Array(Type.String(), { description: "File paths to open for review" }),
      message: Type.Optional(Type.String({ description: "Optional context message shown to the reviewer" })),
    }),
    execute: async (toolCallId: string, params: { files: string[]; message?: string }, signal: AbortSignal | undefined, onUpdate: any, ctx: any) => {
      if (ctx?.hasUI === false) {
        return { content: [{ type: "text", text: "Error: review tool requires interactive mode (a browser)." }] };
      }

      const cwd = pi.cwd ?? process.cwd();
      const { files, warnings } = await resolveFiles(params.files, cwd);

      if (files.length === 0) {
        return { content: [{ type: "text", text: "No files found matching the provided paths." }] };
      }

      const result = await startReviewServer({
        files,
        warnings,
        message: params.message,
        signal,
        onReady: (url: string) => {
          ctx?.ui?.notify?.(`Review ready: ${url}`, "info");
        },
      });

      if (result.cancelled) {
        return { content: [{ type: "text", text: "Review cancelled by user." }] };
      }

      const formatted = formatReviewMessage(result.comments);
      return { content: [{ type: "text", text: formatted }] };
    },
  });

  pi.registerCommand("review", {
    description: "Review files with line-by-line commenting",
    handler: async (args: string, ctx?: any) => {
      const paths = parseArgs(args);
      const isTUI = paths.includes("--tui");
      const filteredPaths = paths.filter((p) => p !== "--tui");

      if (filteredPaths.length === 0) {
        ctx?.ui?.notify?.("Usage: /review [--tui] <file|glob|dir> ...", "info");
        return;
      }

      const cwd = pi.cwd ?? process.cwd();
      const { files, warnings } = await resolveFiles(filteredPaths, cwd);

      if (files.length === 0) {
        ctx?.ui?.notify?.("No files found matching the given paths.", "warning");
        return;
      }

      if (warnings.length > 0) {
        ctx?.ui?.notify?.(`⚠ ${warnings.length} file(s) skipped — see review UI for details`, "warning");
      }

      ctx?.ui?.notify?.(`Opening review for ${files.length} file(s)...`, "info");
      ctx?.ui?.setStatus?.("review", "📝 Review in progress...");

      try {
        let result;

        if (isTUI) {
          const { startTUIReview } = await import("./tui.ts");
          result = await startTUIReview(ctx, { files, warnings });
        } else {
          result = await startReviewServer({
            files,
            warnings,
            onReady: (url) => {
              ctx?.ui?.notify?.(`Review ready: ${url}`);
            },
          });
        }

        if (result.cancelled) {
          ctx?.ui?.notify?.("Review cancelled.", "info");
        } else if (result.comments.length > 0) {
          const message = formatReviewMessage(result.comments);
          pi.sendUserMessage(message);
        }

        return result;
      } finally {
        ctx?.ui?.clearStatus?.("review");
      }
    },
  });
}
