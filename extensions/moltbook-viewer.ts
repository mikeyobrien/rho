/**
 * Moltbook Observations Viewer Extension
 *
 * Shows moltbook observations in a scrollable overlay rendered as markdown.
 *
 * Usage: /moltbook
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { ExtensionAPI, Theme } from "@mariozechner/pi-coding-agent";
import { getMarkdownTheme } from "@mariozechner/pi-coding-agent";
import { Markdown, matchesKey, Key, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import type { TUI } from "@mariozechner/pi-tui";

interface ObservationEntry {
	type: string;
	date: string;
	note: string;
	tags?: string[];
}

function readJsonl<T>(path: string): T[] {
	if (!existsSync(path)) return [];
	const content = readFileSync(path, "utf-8").trim();
	if (!content) return [];
	return content.split("\n").map((line) => JSON.parse(line));
}

function buildMarkdown(): string {
	const brainDir = join(homedir(), ".pi", "brain");
	const observations = readJsonl<ObservationEntry>(join(brainDir, "moltbook-observations.jsonl"));

	if (observations.length === 0) return "# Moltbook Observations\n\n*No observations yet.*";

	let s = `# Moltbook Observations (${observations.length})\n\n`;
	for (const o of observations) {
		const tags = o.tags ? ` \`${o.tags.join("` `")}\`` : "";
		s += `- **${o.type}** (${o.date}): ${o.note}${tags}\n`;
	}
	return s;
}

class MoltbookViewerComponent {
	private scrollOffset = 0;
	private allLines: string[] = [];
	private lastWidth = 0;
	private md: Markdown;
	private disposed = false;

	constructor(
		private tui: TUI,
		private theme: Theme,
		private done: () => void,
	) {
		this.md = new Markdown(buildMarkdown(), 1, 0, getMarkdownTheme());
	}

	handleInput(data: string): void {
		if (this.disposed) return;

		const pageSize = Math.max(1, this.visibleLines() - 2);
		const maxScroll = Math.max(0, this.allLines.length - this.visibleLines());

		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
			this.disposed = true;
			this.done();
		} else if (matchesKey(data, Key.up) || matchesKey(data, "k")) {
			this.scrollOffset = Math.max(0, this.scrollOffset - 1);
			this.tui.requestRender();
		} else if (matchesKey(data, Key.down) || matchesKey(data, "j")) {
			this.scrollOffset = Math.min(maxScroll, this.scrollOffset + 1);
			this.tui.requestRender();
		} else if (matchesKey(data, Key.pageUp) || matchesKey(data, Key.ctrl("u"))) {
			this.scrollOffset = Math.max(0, this.scrollOffset - pageSize);
			this.tui.requestRender();
		} else if (matchesKey(data, Key.pageDown) || matchesKey(data, Key.ctrl("d"))) {
			this.scrollOffset = Math.min(maxScroll, this.scrollOffset + pageSize);
			this.tui.requestRender();
		} else if (matchesKey(data, Key.home) || matchesKey(data, "g")) {
			this.scrollOffset = 0;
			this.tui.requestRender();
		} else if (matchesKey(data, Key.end) || data === "G") {
			this.scrollOffset = maxScroll;
			this.tui.requestRender();
		}
	}

	private visibleLines(): number {
		return Math.max(1, process.stdout.rows - 8);
	}

	render(width: number): string[] {
		const th = this.theme;
		const innerW = Math.max(1, width - 2);

		if (width !== this.lastWidth) {
			this.lastWidth = width;
			this.allLines = this.md.render(innerW);
		}

		const visible = this.visibleLines();
		const maxScroll = Math.max(0, this.allLines.length - visible);
		if (this.scrollOffset > maxScroll) this.scrollOffset = maxScroll;

		const border = (c: string) => th.fg("border", c);
		const accent = (c: string) => th.fg("accent", c);
		const dim = (c: string) => th.fg("dim", c);
		const result: string[] = [];

		const title = ` Moltbook `;
		const titleW = visibleWidth(title);
		const leftPad = Math.floor((innerW - titleW) / 2);
		const rightPad = innerW - titleW - leftPad;
		result.push(
			border("╭") + border("─".repeat(leftPad)) + accent(title) + border("─".repeat(rightPad)) + border("╮"),
		);

		const total = this.allLines.length;
		const pos = total > 0 ? Math.floor(((this.scrollOffset + visible / 2) / Math.max(1, total)) * 100) : 0;
		const scrollInfo = `${Math.min(pos, 100)}% (${this.scrollOffset + 1}-${Math.min(this.scrollOffset + visible, total)}/${total})`;
		result.push(border("│") + truncateToWidth(dim(` ${scrollInfo}`), innerW, "", true) + border("│"));
		result.push(border("├") + border("─".repeat(innerW)) + border("┤"));

		const visibleSlice = this.allLines.slice(this.scrollOffset, this.scrollOffset + visible);
		for (const line of visibleSlice) {
			result.push(border("│") + truncateToWidth(line, innerW, "…", true) + border("│"));
		}
		for (let i = visibleSlice.length; i < visible; i++) {
			result.push(border("│") + " ".repeat(innerW) + border("│"));
		}

		result.push(border("├") + border("─".repeat(innerW)) + border("┤"));
		const help = " ↑↓/jk scroll  PgUp/Dn page  Home/End jump  Esc close";
		result.push(border("│") + truncateToWidth(dim(help), innerW, "", true) + border("│"));
		result.push(border("╰") + border("─".repeat(innerW)) + border("╯"));

		return result;
	}

	invalidate(): void {
		this.lastWidth = 0;
		this.md.invalidate();
	}
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("moltbook", {
		description: "View moltbook observations in a scrollable overlay",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("moltbook requires interactive mode", "error");
				return;
			}

			await ctx.ui.custom<void>(
				(tui, theme, _kb, done) => new MoltbookViewerComponent(tui, theme, done),
				{
					overlay: true,
					overlayOptions: {
						anchor: "center",
						width: "90%",
						minWidth: 60,
						maxHeight: "95%",
					},
				},
			);
		},
	});
}
