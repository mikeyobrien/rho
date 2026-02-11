import type { ReviewComment } from "./server.ts";

const HEADER = `## Review Comments

The following review comments were left on the specified files. Please summarize your plan to address each comment, then wait for confirmation before making changes.`;

export function formatReviewMessage(comments: ReviewComment[]): string {
  if (comments.length === 0) return HEADER;

  // Group by file, preserving insertion order
  const grouped = new Map<string, ReviewComment[]>();
  for (const c of comments) {
    let group = grouped.get(c.file);
    if (!group) {
      group = [];
      grouped.set(c.file, group);
    }
    group.push(c);
  }

  const sections: string[] = [HEADER];

  for (const [file, fileComments] of grouped) {
    sections.push(`### ${file}`);

    for (const c of fileComments) {
      const lineLabel =
        c.startLine === c.endLine
          ? `**Line ${c.startLine}:**`
          : `**Lines ${c.startLine}-${c.endLine}:**`;

      const quote = c.selectedText
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n");

      sections.push(`${lineLabel}\n${quote}\n\n${c.comment}`);
    }
  }

  return sections.join("\n\n");
}
