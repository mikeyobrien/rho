import { matchesKey, Key, truncateToWidth, visibleWidth, SelectList, Input } from "@mariozechner/pi-tui";
import type { SelectItem, SelectListTheme } from "@mariozechner/pi-tui";
import type { ReviewFile } from "./files.ts";
import type { ReviewComment, ReviewResult } from "./server.ts";

export interface TUIReviewOptions {
  files: ReviewFile[];
  warnings?: string[];
  message?: string;
}

export async function startTUIReview(
  ctx: any,
  options: TUIReviewOptions
): Promise<ReviewResult> {
  const { files } = options;
  const multiFile = files.length > 1;

  return ctx.ui.custom<ReviewResult>(
    (tui: any, theme: any, _keybindings: any, done: (result: ReviewResult) => void) => {
      // -- State --
      let activeFileIndex = 0;
      let cursorLine = 1;
      let scrollOffset = 0;
      let cachedLines: string[] | undefined;
      let cachedWidth: number | undefined;
      let mode: "browse" | "files" | "comment" | "range" | "comments" = "browse";
      let selectList: InstanceType<typeof SelectList> | null = null;
      let comments: Map<string, ReviewComment[]> = new Map();
      let editingComment: { startLine: number; endLine: number } | null = null;
      let input: InstanceType<typeof Input> | null = null;
      let rangeAnchor: number | null = null;
      let commentListIndex = 0;
      let editingExisting: { fileKey: string; index: number } | null = null;
      let showHelp = false;

      // -- Derived state (recomputed on file switch) --
      let sourceLines: string[] = [];
      let totalLines = 0;
      let lineNumWidth = 3;

      function loadFile(index: number): void {
        activeFileIndex = index;
        const file = files[activeFileIndex];
        sourceLines = file.content.split("\n");
        totalLines = sourceLines.length;
        lineNumWidth = Math.max(3, String(totalLines).length);
        cursorLine = 1;
        scrollOffset = 0;
        cachedLines = undefined;
        cachedWidth = undefined;
      }

      // Load initial file
      loadFile(0);

      function getCommentsForLine(lineNum: number): ReviewComment[] {
        const fileComments = comments.get(files[activeFileIndex].relativePath) ?? [];
        return fileComments.filter(c => lineNum >= c.startLine && lineNum <= c.endLine);
      }

      function getAllComments(): Array<{ fileKey: string; index: number; comment: ReviewComment }> {
        const result: Array<{ fileKey: string; index: number; comment: ReviewComment }> = [];
        for (const [fileKey, fileComments] of comments) {
          for (let i = 0; i < fileComments.length; i++) {
            result.push({ fileKey, index: i, comment: fileComments[i] });
          }
        }
        return result;
      }

      function clampScroll(viewportHeight: number): void {
        if (cursorLine < 1) cursorLine = 1;
        if (cursorLine > totalLines) cursorLine = totalLines;

        const cursorIdx = cursorLine - 1;
        if (cursorIdx < scrollOffset) {
          scrollOffset = cursorIdx;
        }
        if (cursorIdx >= scrollOffset + viewportHeight) {
          scrollOffset = cursorIdx - viewportHeight + 1;
        }

        if (scrollOffset < 0) scrollOffset = 0;
        const maxScroll = Math.max(0, totalLines - viewportHeight);
        if (scrollOffset > maxScroll) scrollOffset = maxScroll;
      }

      function switchFile(index: number): void {
        loadFile(index);
        tui.requestRender();
      }

      function enterFilesMode(): void {
        const items: SelectItem[] = files.map((f, i) => {
          const count = (comments.get(f.relativePath) ?? []).length;
          return {
            value: String(i),
            label: f.relativePath,
            description: `${count} comment${count !== 1 ? "s" : ""}`,
          };
        });

        const slTheme: SelectListTheme = {
          selectedPrefix: (t: string) => theme.fg("accent", t),
          selectedText: (t: string) => theme.fg("accent", t),
          description: (t: string) => theme.fg("muted", t),
          scrollInfo: (t: string) => theme.fg("dim", t),
          noMatch: (t: string) => theme.fg("warning", t),
        };

        selectList = new SelectList(items, Math.min(items.length, 10), slTheme);
        selectList.setSelectedIndex(activeFileIndex);

        selectList.onSelect = (item: SelectItem) => {
          const idx = Number(item.value);
          mode = "browse";
          selectList = null;
          switchFile(idx);
        };

        selectList.onCancel = () => {
          mode = "browse";
          selectList = null;
          cachedLines = undefined;
          tui.requestRender();
        };

        mode = "files";
        cachedLines = undefined;
        tui.requestRender();
      }

      function saveComment(text: string): void {
        if (!text.trim() || !editingComment) return;
        const { startLine, endLine } = editingComment;
        const selectedText = sourceLines.slice(startLine - 1, endLine).join("\n");

        if (editingExisting) {
          const { fileKey, index } = editingExisting;
          const fileComments = comments.get(fileKey) ?? [];
          if (index < fileComments.length) {
            fileComments[index] = {
              file: fileKey,
              startLine,
              endLine,
              selectedText,
              comment: text.trim(),
            };
            comments.set(fileKey, fileComments);
          }
          editingExisting = null;
        } else {
          const file = files[activeFileIndex];
          const comment: ReviewComment = {
            file: file.relativePath,
            startLine,
            endLine,
            selectedText,
            comment: text.trim(),
          };
          const key = file.relativePath;
          const existing = comments.get(key) ?? [];
          existing.push(comment);
          comments.set(key, existing);
        }

        mode = "browse";
        editingComment = null;
        input = null;
        cachedLines = undefined;
        tui.requestRender();
      }

      function cancelComment(): void {
        mode = "browse";
        editingComment = null;
        editingExisting = null;
        input = null;
        cachedLines = undefined;
        tui.requestRender();
      }

      return {
        render(width: number): string[] {
          if (cachedLines && cachedWidth === width) return cachedLines;

          const height = tui.terminal.rows - 2; // account for pi's status bar
          const hasMessage = !!options.message;
          const viewportHeight = height - 4 - (hasMessage ? 1 : 0); // header + 2 separators + hints + optional message
          const file = files[activeFileIndex];
          const isEmpty = totalLines === 1 && sourceLines[0] === "";
          const lines: string[] = [];

          // Row 1: Header
          const fileLabel = multiFile
            ? `${file.relativePath} (${activeFileIndex + 1}/${files.length})`
            : file.relativePath;
          const totalComments = Array.from(comments.values()).reduce((sum, arr) => sum + arr.length, 0);
          const warningsBadge = options.warnings?.length
            ? `  ·  ⚠ ${options.warnings.length} warning${options.warnings.length !== 1 ? "s" : ""}`
            : "";
          const headerText = ` ${fileLabel}  ·  ${totalComments} comment${totalComments !== 1 ? "s" : ""}${warningsBadge}  ·  ? help`;
          lines.push(theme.bold(truncateToWidth(headerText, width)));

          // Row 2: Separator
          lines.push(theme.fg("dim", "─".repeat(width)));

          // Optional context message
          if (hasMessage) {
            lines.push(theme.fg("dim", truncateToWidth(` ${options.message}`, width)));
          }

          if (mode === "files" && selectList) {
            // -- FILES mode --
            const labelLine = " Select file";
            lines.push(theme.fg("muted", truncateToWidth(labelLine, width)));

            const listLines = selectList.render(width);
            const availableRows = viewportHeight - 1; // -1 for label line
            for (let i = 0; i < availableRows; i++) {
              lines.push(i < listLines.length ? listLines[i] : "");
            }

            // Row H-1: Separator
            lines.push(theme.fg("dim", "─".repeat(width)));

            // Row H: Hints for files mode
            const fileHints = "↑↓ select · Enter open · Esc cancel";
            lines.push(theme.fg("muted", truncateToWidth(fileHints, width)));
          } else if (mode === "comments") {
            // -- COMMENTS list mode --
            const allComments = getAllComments();
            const labelLine = ` All Comments (${allComments.length})`;
            lines.push(theme.fg("muted", truncateToWidth(labelLine, width)));

            const listHeight = viewportHeight - 1; // -1 for label line
            let listScroll = 0;
            if (commentListIndex >= listHeight) {
              listScroll = commentListIndex - listHeight + 1;
            }

            for (let i = 0; i < listHeight; i++) {
              const idx = listScroll + i;
              if (idx >= allComments.length) {
                lines.push("");
                continue;
              }
              const { fileKey, comment } = allComments[idx];
              const isSelected = idx === commentListIndex;
              const prefix = isSelected ? "▸ " : "  ";
              const loc = comment.startLine === comment.endLine
                ? `${fileKey}:${comment.startLine}`
                : `${fileKey}:${comment.startLine}-${comment.endLine}`;
              const textWidth = Math.max(0, width - visibleWidth(prefix) - visibleWidth(loc) - 5);
              const truncatedComment = truncateToWidth(comment.comment, textWidth);
              const itemLine = `${prefix}${loc} "${truncatedComment}"`;

              if (isSelected) {
                lines.push(theme.fg("accent", truncateToWidth(itemLine, width)));
              } else {
                lines.push(truncateToWidth(itemLine, width));
              }
            }

            lines.push(theme.fg("dim", "─".repeat(width)));
            lines.push(theme.fg("muted", truncateToWidth("j/k navigate · Enter edit · d delete · Esc back", width)));
          } else if (showHelp) {
            // -- HELP overlay --
            const helpLabel = " Review Help";
            lines.push(theme.fg("accent", truncateToWidth(helpLabel, width)));

            const helpEntries = [
              "  j/k  ↑/↓       Scroll up/down",
              "  g/G            Top / bottom",
              "  Ctrl+d/u       Page down / up",
              "  Enter          Comment on line",
              "  v              Range select",
              "  Tab/Shift+Tab  Next/previous file",
              "  f              File picker",
              "  c              Comment list",
              "  S              Submit review",
              "  Esc            Cancel review",
              "  ?              Toggle this help",
            ];

            const helpAreaHeight = viewportHeight - 1; // -1 for label
            for (let i = 0; i < helpAreaHeight; i++) {
              lines.push(i < helpEntries.length ? truncateToWidth(helpEntries[i], width) : "");
            }

            lines.push(theme.fg("dim", "─".repeat(width)));
            lines.push(theme.fg("muted", truncateToWidth("Press any key to close", width)));
          } else {
            // -- BROWSE or COMMENT mode --
            const isComment = mode === "comment";
            const codeViewportHeight = isComment ? height - 7 - (hasMessage ? 1 : 0) : viewportHeight;
            clampScroll(codeViewportHeight);

            if (isEmpty) {
              // Empty file: centered placeholder
              const emptyMsg = "(empty file)";
              const padLeft = Math.max(0, Math.floor((width - emptyMsg.length) / 2));
              const midRow = Math.floor(codeViewportHeight / 2);
              for (let i = 0; i < codeViewportHeight; i++) {
                if (i === midRow) {
                  lines.push(theme.fg("muted", " ".repeat(padLeft) + emptyMsg));
                } else {
                  lines.push("");
                }
              }
            } else {
              const prefixWidth = 1 + lineNumWidth + 1 + 1;

              let renderedLines = 0;
              let codeLineIdx = 0;

              while (renderedLines < codeViewportHeight) {
                const lineIdx = scrollOffset + codeLineIdx;
                if (lineIdx >= totalLines) {
                  lines.push("");
                  renderedLines++;
                  codeLineIdx++;
                  continue;
                }

                const lineNum = lineIdx + 1;
                const isCursor = lineNum === cursorLine;
                const source = sourceLines[lineIdx].replace(/\t/g, "  ");
                const lineComments = getCommentsForLine(lineNum);
                const hasComments = lineComments.length > 0;

                const cursorChar = isCursor ? "▸" : " ";
                const numStr = String(lineNum).padStart(lineNumWidth, " ");
                const marker = hasComments ? theme.fg("warning", "●") : " ";

                const codeWidth = Math.max(0, width - prefixWidth);
                const truncatedCode = truncateToWidth(source, codeWidth);

                const inRange = mode === "range" && rangeAnchor !== null &&
                  lineNum >= Math.min(rangeAnchor, cursorLine) &&
                  lineNum <= Math.max(rangeAnchor, cursorLine);

                if (isCursor) {
                  const raw = `${cursorChar}${numStr}│${hasComments ? "●" : " "}${truncatedCode}`;
                  const styled = theme.fg("accent", truncateToWidth(raw, width));
                  lines.push(inRange ? theme.bg("selectedBg", styled) : styled);
                } else if (inRange) {
                  const raw = `${cursorChar}${numStr}│${hasComments ? "●" : " "}${truncatedCode}`;
                  lines.push(theme.bg("selectedBg", truncateToWidth(raw, width)));
                } else {
                  lines.push(
                    `${cursorChar}${theme.fg("dim", numStr)}${theme.fg("dim", "│")}${marker}${truncatedCode}`
                  );
                }
                renderedLines++;

                // Inline comment expansion when cursor is on a commented line
                if (isCursor && hasComments) {
                  const gutterPad = " ".repeat(1 + lineNumWidth);
                  const commentContentWidth = Math.max(0, width - lineNumWidth - 6);
                  for (const c of lineComments) {
                    if (renderedLines >= codeViewportHeight) break;
                    const commentText = truncateToWidth(c.comment, commentContentWidth);
                    lines.push(
                      `${gutterPad}${theme.fg("dim", "│")}${theme.fg("muted", "  ▸ " + commentText)}`
                    );
                    renderedLines++;
                  }
                }

                codeLineIdx++;
              }
            }

            if (isComment && input && editingComment) {
              // Comment input panel
              const commentLabel = editingComment.startLine === editingComment.endLine
                ? ` Comment on line ${editingComment.startLine} `
                : ` Comment on lines ${editingComment.startLine}-${editingComment.endLine} `;
              const labelSection = `──${commentLabel}`;
              const remaining = Math.max(0, width - visibleWidth(labelSection));
              lines.push(theme.fg("dim", labelSection + "─".repeat(remaining)));

              const inputLines = input.render(width);
              lines.push(inputLines[0] || "");

              lines.push(theme.fg("dim", "─".repeat(width)));
              lines.push(theme.fg("muted", truncateToWidth("Enter save · Esc cancel", width)));
            } else if (mode === "range" && rangeAnchor !== null) {
              // Row H-1: Separator
              lines.push(theme.fg("dim", "─".repeat(width)));

              // Row H: Range mode hints
              const rangeStart = Math.min(rangeAnchor, cursorLine);
              const rangeEnd = Math.max(rangeAnchor, cursorLine);
              const rangeHints = `RANGE ${rangeStart}-${rangeEnd} · j/k extend · Enter comment · Esc cancel`;
              lines.push(theme.fg("muted", truncateToWidth(rangeHints, width)));
            } else {
              // Row H-1: Separator
              lines.push(theme.fg("dim", "─".repeat(width)));

              // Row H: Key hints
              const baseHints = ["j/k scroll", "Enter comment", "v range", "c comments", "S submit", "Esc cancel"];
              if (multiFile) {
                baseHints.push("Tab next", "f files");
              }
              const hints = baseHints.join(" · ");
              lines.push(theme.fg("muted", truncateToWidth(hints, width)));
            }
          }

          cachedLines = lines;
          cachedWidth = width;
          return lines;
        },

        handleInput(data: string): void {
          // FILES mode: forward everything to SelectList
          if (mode === "files" && selectList) {
            selectList.handleInput(data);
            cachedLines = undefined;
            tui.requestRender();
            return;
          }

          // COMMENT mode: forward everything to Input
          if (mode === "comment" && input) {
            input.handleInput(data);
            cachedLines = undefined;
            tui.requestRender();
            return;
          }

          // COMMENTS list mode
          if (mode === "comments") {
            const allComments = getAllComments();

            if (matchesKey(data, "j") || matchesKey(data, Key.down)) {
              if (allComments.length > 0) {
                commentListIndex = Math.min(commentListIndex + 1, allComments.length - 1);
              }
            } else if (matchesKey(data, "k") || matchesKey(data, Key.up)) {
              if (allComments.length > 0) {
                commentListIndex = Math.max(commentListIndex - 1, 0);
              }
            } else if (matchesKey(data, Key.enter)) {
              if (allComments.length > 0 && commentListIndex < allComments.length) {
                const entry = allComments[commentListIndex];
                const fileIdx = files.findIndex(f => f.relativePath === entry.fileKey);
                if (fileIdx >= 0) {
                  loadFile(fileIdx);
                  cursorLine = entry.comment.startLine;
                  editingComment = { startLine: entry.comment.startLine, endLine: entry.comment.endLine };
                  editingExisting = { fileKey: entry.fileKey, index: entry.index };
                  input = new Input();
                  input.setValue(entry.comment.comment);
                  input.onSubmit = (text: string) => { saveComment(text); };
                  input.onEscape = () => { cancelComment(); };
                  mode = "comment";
                }
              }
            } else if (matchesKey(data, "d")) {
              if (allComments.length > 0 && commentListIndex < allComments.length) {
                const entry = allComments[commentListIndex];
                const fileComments = comments.get(entry.fileKey) ?? [];
                fileComments.splice(entry.index, 1);
                if (fileComments.length === 0) {
                  comments.delete(entry.fileKey);
                } else {
                  comments.set(entry.fileKey, fileComments);
                }
                const remaining = getAllComments();
                if (remaining.length === 0) {
                  mode = "browse";
                } else {
                  commentListIndex = Math.min(commentListIndex, remaining.length - 1);
                }
              }
            } else if (matchesKey(data, Key.escape)) {
              mode = "browse";
            }

            cachedLines = undefined;
            tui.requestRender();
            return;
          }

          // Help overlay: any key closes it
          if (showHelp) {
            showHelp = false;
            cachedLines = undefined;
            tui.requestRender();
            return;
          }

          // RANGE mode
          if (mode === "range" && rangeAnchor !== null) {
            const height = tui.terminal.rows - 2;
            const hasMessage = !!options.message;
            const viewportHeight = height - 4 - (hasMessage ? 1 : 0);
            const halfPage = Math.max(1, Math.floor(viewportHeight / 2));

            if (matchesKey(data, "j") || matchesKey(data, Key.down)) {
              if (cursorLine < totalLines) cursorLine++;
            } else if (matchesKey(data, "k") || matchesKey(data, Key.up)) {
              if (cursorLine > 1) cursorLine--;
            } else if (matchesKey(data, "g")) {
              cursorLine = 1;
              scrollOffset = 0;
            } else if (matchesKey(data, Key.shift("g"))) {
              cursorLine = totalLines;
            } else if (matchesKey(data, Key.ctrl("d")) || matchesKey(data, Key.pageDown)) {
              cursorLine = Math.min(totalLines, cursorLine + halfPage);
            } else if (matchesKey(data, Key.ctrl("u")) || matchesKey(data, Key.pageUp)) {
              cursorLine = Math.max(1, cursorLine - halfPage);
            } else if (matchesKey(data, Key.enter)) {
              const startLine = Math.min(rangeAnchor, cursorLine);
              const endLine = Math.max(rangeAnchor, cursorLine);
              editingComment = { startLine, endLine };
              input = new Input();
              input.onSubmit = (text: string) => { saveComment(text); };
              input.onEscape = () => { cancelComment(); };
              rangeAnchor = null;
              mode = "comment";
              cachedLines = undefined;
              tui.requestRender();
              return;
            } else if (matchesKey(data, Key.escape) || matchesKey(data, "v")) {
              rangeAnchor = null;
              mode = "browse";
              cachedLines = undefined;
              tui.requestRender();
              return;
            }

            cachedLines = undefined;
            tui.requestRender();
            return;
          }

          // BROWSE mode
          const height = tui.terminal.rows - 2;
          const hasMessage = !!options.message;
          const viewportHeight = height - 4 - (hasMessage ? 1 : 0);
          const halfPage = Math.max(1, Math.floor(viewportHeight / 2));
          const isEmpty = totalLines === 1 && sourceLines[0] === "";

          if (matchesKey(data, "j") || matchesKey(data, Key.down)) {
            if (cursorLine < totalLines) cursorLine++;
          } else if (matchesKey(data, "k") || matchesKey(data, Key.up)) {
            if (cursorLine > 1) cursorLine--;
          } else if (matchesKey(data, "g")) {
            cursorLine = 1;
            scrollOffset = 0;
          } else if (matchesKey(data, Key.shift("g"))) {
            cursorLine = totalLines;
          } else if (matchesKey(data, Key.ctrl("d")) || matchesKey(data, Key.pageDown)) {
            cursorLine = Math.min(totalLines, cursorLine + halfPage);
          } else if (matchesKey(data, Key.ctrl("u")) || matchesKey(data, Key.pageUp)) {
            cursorLine = Math.max(1, cursorLine - halfPage);
          } else if (multiFile && matchesKey(data, Key.tab)) {
            // Tab: next file (wrap)
            switchFile((activeFileIndex + 1) % files.length);
            return;
          } else if (multiFile && matchesKey(data, Key.shift("tab"))) {
            // Shift+Tab: previous file (wrap)
            switchFile((activeFileIndex - 1 + files.length) % files.length);
            return;
          } else if (multiFile && matchesKey(data, "f")) {
            enterFilesMode();
            return;
          } else if (matchesKey(data, Key.enter)) {
            if (isEmpty) return; // no commenting on empty files
            editingComment = { startLine: cursorLine, endLine: cursorLine };
            input = new Input();
            input.onSubmit = (text: string) => { saveComment(text); };
            input.onEscape = () => { cancelComment(); };
            mode = "comment";
            cachedLines = undefined;
            tui.requestRender();
            return;
          } else if (matchesKey(data, "v")) {
            if (isEmpty) return; // no range select on empty files
            rangeAnchor = cursorLine;
            mode = "range";
            cachedLines = undefined;
            tui.requestRender();
            return;
          } else if (matchesKey(data, "c")) {
            const totalComments = Array.from(comments.values()).reduce((sum, arr) => sum + arr.length, 0);
            if (totalComments > 0) {
              mode = "comments";
              commentListIndex = 0;
              cachedLines = undefined;
              tui.requestRender();
              return;
            }
          } else if (matchesKey(data, Key.shift("s"))) {
            const allComments: ReviewComment[] = [];
            for (const fileComments of comments.values()) {
              allComments.push(...fileComments);
            }
            if (allComments.length === 0) return;
            done({ comments: allComments, cancelled: false });
            return;
          } else if (matchesKey(data, Key.escape)) {
            done({ comments: [], cancelled: true });
            return;
          } else if (matchesKey(data, "?")) {
            showHelp = true;
            cachedLines = undefined;
            tui.requestRender();
            return;
          }

          cachedLines = undefined;
          tui.requestRender();
        },

        invalidate(): void {
          cachedLines = undefined;
          cachedWidth = undefined;
        },
      };
    }
  );
}
