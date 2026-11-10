// Types for the page's Markdown reader, which is plain JavaScript so a browser runs it as it is.
export type InlinePart = { type: "text" | "code" | "strong" | "em"; text: string } | { type: "link"; text: string; href: string };
export type Block =
	| { type: "paragraph"; text: string }
	| { type: "code"; text: string; language: string }
	| { type: "heading"; level: number; text: string }
	| { type: "list"; ordered: boolean; items: string[] }
	| { type: "table"; header: string[]; align: (null | "left" | "center" | "right")[]; rows: string[][] };
export function parseInline(text: string): InlinePart[];
export function parseBlocks(source: string): any[];
export function renderMarkdown(parent: unknown, source: string, document: unknown): void;
