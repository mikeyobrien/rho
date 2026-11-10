import { expect, test } from "bun:test";
import { parseBlocks, parseInline, renderMarkdown } from "../web/markdown.js";
import { El, fakeDocument, tags } from "./fixtures/dom.ts";

const render = (source: string) => {
	const document = fakeDocument();
	const parent = document.createElement("div");
	renderMarkdown(parent, source, document);
	return parent;
};

test("markup in a reply stays text and creates no element", () => {
	const source = 'Hello <script>alert(1)</script> <img src=x onerror=alert(1)>';
	const parent = render(source);
	expect(tags(parent)).toEqual(["div", "p", "#text"]);
	expect(parent.textContent).toBe(source);
	const inTable = render("| a |\n|---|\n| <script>alert(1)</script> |");
	expect(tags(inTable)).not.toContain("script");
	expect(inTable.textContent).toContain("<script>alert(1)</script>");
});

test("only http and https links become links, opened in a new tab with no opener", () => {
	expect(parseInline("[a](https://example.com)")).toEqual([{ type: "link", text: "a", href: "https://example.com" }]);
	for (const href of ["javascript:alert(1)", "JaVaScRiPt:alert(1)", "data:text/html,x", "intent://x", "//evil.example", "file:///etc/passwd"]) {
		const parts = parseInline(`[click](${href})`);
		expect(parts.some((part: { type: string }) => part.type === "link")).toBe(false);
		expect(parts.map((part: { text: string }) => part.text).join("")).toBe(`[click](${href})`);
	}
	const link = render("[site](https://example.com/a?b=1)").all().find((node) => node.tag === "a") as El & { rel: string; target: string; href: string };
	expect([link.rel, link.target, link.href]).toEqual(["noopener noreferrer", "_blank", "https://example.com/a?b=1"]);
});

test("inline marks: code, strong, emphasis; a lone asterisk is text", () => {
	expect(parseInline("A `code` and **bold** and *soft* word.").map((part: { type: string }) => part.type)).toEqual(["text", "code", "text", "strong", "text", "em", "text"]);
	expect(parseInline("2 * 3 * 4")).toEqual([{ type: "text", text: "2 * 3 * 4" }]);
	expect(parseInline("`**not bold**`")).toEqual([{ type: "code", text: "**not bold**" }]);
});

test("code fences keep their text exactly; one that never closes takes the rest", () => {
	expect(parseBlocks("Before\n\n```html\n<b>x</b>\n  **not bold**\n| a | b |\n|---|---|\n```\nAfter")).toEqual([
		{ type: "paragraph", text: "Before" },
		{ type: "code", text: "<b>x</b>\n  **not bold**\n| a | b |\n|---|---|", language: "html" },
		{ type: "paragraph", text: "After" },
	]);
	expect(parseBlocks("```\nstill streaming")).toEqual([{ type: "code", text: "still streaming", language: "" }]);
});

test("headings, lists and paragraphs", () => {
	const blocks = parseBlocks("# Title\n- one\n- two\n  wrapped\n\n1. first\n2. second\n\nA paragraph\nof two lines.");
	expect(blocks.map((block: { type: string }) => block.type)).toEqual(["heading", "list", "list", "paragraph"]);
	expect(blocks[1].items).toEqual(["one", "two wrapped"]);
	expect(blocks[2].ordered).toBe(true);
	expect(parseBlocks("- one\nplain line").map((block: { type: string }) => block.type)).toEqual(["list", "paragraph"]);
	expect(tags(render("A\nB"))).toEqual(["div", "p", "#text", "br", "#text"]);
	expect(render("").children).toEqual([]);
	expect(render("\n\n  \n").children).toEqual([]);
});

test("tables: alignment, optional outer pipes, escaped pipes, short and long rows", () => {
	expect(parseBlocks("| a | b |\n|:--|--:|\n| 1 | 2 |\n| 3 |\n| 4 | 5 | 6 |")).toEqual([{ type: "table", header: ["a", "b"], align: ["left", "right"], rows: [["1", "2"], ["3", ""], ["4", "5"]] }]);
	expect(parseBlocks("a | b\n--- | :-:\nx \\| y | 2")[0]).toEqual({ type: "table", header: ["a", "b"], align: [null, "center"], rows: [["x | y", "2"]] });
	expect(parseBlocks("| a | b |\n|---|---|")[0].rows).toEqual([]);
	expect(parseBlocks("Intro\n| a | b |\n|---|---|\n| 1 | 2 |\nAfter").map((block: { type: string }) => block.type)).toEqual(["paragraph", "table", "paragraph"]);
	// No delimiter row, or one of the wrong width: not a table.
	expect(parseBlocks("| a | b |")).toEqual([{ type: "paragraph", text: "| a | b |" }]);
	expect(parseBlocks("| a | b |\n|---|\n| 1 | 2 |").some((block: { type: string }) => block.type === "table")).toBe(false);
	const table = render("| a | b |\n|---|--:|\n| **x** | `c` |");
	expect(tags(table)).toEqual(["div", "div", "table", "thead", "tr", "th", "#text", "th", "#text", "tbody", "tr", "td", "strong", "td", "code"]);
	expect(table.all().filter((node) => node.tag === "td").map((node) => node.className)).toEqual(["", "align-right"]);
	expect(tags(render("| a |\n|---|"))).not.toContain("tbody");
});
