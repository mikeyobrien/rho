/**
 * Memory Viewer Extension
 *
 * Shows all brain memories in a scrollable overlay rendered as markdown.
 *
 * Usage: /memories
 *
 * Keys:
 *   ↑/↓/j/k   - Scroll one line
 *   PgUp/Dn    - Scroll one page
 *   g/G        - Jump to top/bottom
 *   Tab/S-Tab  - Jump to next/prev section
 *   r          - Refresh data
 *   Esc        - Close
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { getMarkdownTheme } from "@mariozechner/pi-coding-agent";
import { Markdown, Input, matchesKey, Key, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import type { TUI } from "@mariozechner/pi-tui";
import type { Theme } from "@mariozechner/pi-coding-agent";
import { readBrain, foldBrain, BRAIN_PATH, scoreLearning } from "../lib/brain-store.ts";
import type { LearningEntry } from "../lib/brain-store.ts";

function fmtDate(iso: string): string {
	return iso.slice(0, 10);
}

function matches(query: string, ...fields: (string | undefined | null)[]): boolean {
	const q = query.toLowerCase();
	return fields.some((f) => f && f.toLowerCase().includes(q));
}

function buildMarkdown(detailed = false, filter = ""): string {
	const { entries } = readBrain(BRAIN_PATH);
	const brain = foldBrain(entries);
	const sections: string[] = [];
	const cwd = process.cwd();
	const f = filter.trim();

	// Behavior section
	const filteredBehaviors = f ? brain.behaviors.filter((b) => matches(f, b.text)) : brain.behaviors;
	if (filteredBehaviors.length > 0) {
		const dos = filteredBehaviors.filter((b) => b.category === "do");
		const donts = filteredBehaviors.filter((b) => b.category === "dont");
		const values = filteredBehaviors.filter((b) => b.category === "value");

		const count = f ? `${filteredBehaviors.length}/${brain.behaviors.length} match` : `${dos.length} do, ${donts.length} don't, ${values.length} values`;
		let s = `# Behavior (${count})\n`;
		if (dos.length > 0) {
			s += "\n**Do:**\n";
			for (const b of dos) s += detailed ? `- ${b.text}  \`[${b.id}]\`\n` : `- ${b.text}\n`;
		}
		if (donts.length > 0) {
			s += "\n**Don't:**\n";
			for (const b of donts) s += detailed ? `- ${b.text}  \`[${b.id}]\`\n` : `- ${b.text}\n`;
		}
		if (values.length > 0) {
			s += "\n**Values:**\n";
			for (const b of values) s += detailed ? `- ${b.text}  \`[${b.id}]\`\n` : `- ${b.text}\n`;
		}
		sections.push(s);
	}

	// Identity section
	const filteredIdentity = f ? [...brain.identity].filter(([k, e]) => matches(f, k, e.value)) : [...brain.identity];
	if (filteredIdentity.length > 0) {
		const count = f ? `${filteredIdentity.length}/${brain.identity.size} match` : `${brain.identity.size}`;
		let s = `# Identity (${count})\n`;
		for (const [key, entry] of filteredIdentity) {
			s += detailed ? `- ${key}: ${entry.value}  \`[${fmtDate(entry.created)}]\`\n` : `- ${key}: ${entry.value}\n`;
		}
		sections.push(s);
	}

	// User section
	const filteredUser = f ? [...brain.user].filter(([k, e]) => matches(f, k, e.value)) : [...brain.user];
	if (filteredUser.length > 0) {
		const count = f ? `${filteredUser.length}/${brain.user.size} match` : `${brain.user.size}`;
		let s = `# User (${count})\n`;
		for (const [key, entry] of filteredUser) {
			s += detailed ? `- ${key}: ${entry.value}  \`[${fmtDate(entry.created)}]\`\n` : `- ${key}: ${entry.value}\n`;
		}
		sections.push(s);
	}

	// Preferences section
	const filteredPrefs = f ? brain.preferences.filter((p) => matches(f, p.text, p.category)) : brain.preferences;
	if (filteredPrefs.length > 0) {
		const count = f ? `${filteredPrefs.length}/${brain.preferences.length} match` : `${brain.preferences.length}`;
		let s = `# Preferences (${count})\n`;
		const byCategory = new Map<string, typeof filteredPrefs>();
		for (const p of filteredPrefs) {
			const cat = p.category || "General";
			if (!byCategory.has(cat)) byCategory.set(cat, []);
			byCategory.get(cat)!.push(p);
		}
		for (const [cat, prefs] of byCategory) {
			s += `\n**${cat}:**\n`;
			for (const e of prefs) s += detailed ? `- ${e.text}  \`[${e.id} · ${fmtDate(e.created)}]\`\n` : `- ${e.text}\n`;
		}
		sections.push(s);
	}

	// Context section
	const filteredContexts = f ? brain.contexts.filter((c) => matches(f, c.project, c.path, c.content)) : brain.contexts;
	if (filteredContexts.length > 0) {
		const count = f ? `${filteredContexts.length}/${brain.contexts.length} match` : `${brain.contexts.length}`;
		let s = `# Context (${count})\n`;
		for (const c of filteredContexts) {
			s += detailed ? `- **${c.project}** — ${c.path}  \`[${c.id} · ${fmtDate(c.created)}]\`\n` : `- **${c.project}** — ${c.path}\n`;
		}
		sections.push(s);
	}

	// Learnings section
	const filteredLearnings = f ? brain.learnings.filter((l) => matches(f, l.text)) : brain.learnings;
	if (filteredLearnings.length > 0) {
		const count = f ? `${filteredLearnings.length}/${brain.learnings.length} match` : `${brain.learnings.length}`;
		let s = `# Learnings (${count})\n`;
		for (const l of filteredLearnings) {
			if (detailed) {
				const score = scoreLearning(l, cwd);
				const src = l.source || "unknown";
				s += `- ${l.text}  \`[${src} · ${fmtDate(l.created)} · score:${score}]\`\n`;
			} else {
				s += `- ${l.text}\n`;
			}
		}
		sections.push(s);
	}

	// Reminders section
	const filteredReminders = f ? brain.reminders.filter((r) => matches(f, r.text)) : brain.reminders;
	if (filteredReminders.length > 0) {
		const count = f ? `${filteredReminders.length}/${brain.reminders.length} match` : `${brain.reminders.length}`;
		let s = `# Reminders (${count})\n\n`;
		for (const r of filteredReminders) {
			const status = r.enabled ? "active" : "disabled";
			const cadence = r.cadence.kind === "interval" ? `every ${r.cadence.every}` : `daily at ${r.cadence.at}`;
			if (detailed) {
				const lastRun = r.last_run ? `last:${fmtDate(r.last_run)}` : "never run";
				const nextDue = r.next_due ? `next:${fmtDate(r.next_due)}` : "";
				const result = r.last_result ? `result:${r.last_result}` : "";
				const meta = [lastRun, nextDue, result].filter(Boolean).join(" · ");
				s += `- [${r.id}] ${r.text} (${cadence}, ${status})  \`[${meta}]\`\n`;
			} else {
				s += `- [${r.id}] ${r.text} (${cadence}, ${status})\n`;
			}
		}
		sections.push(s);
	}

	// Tasks section
	const filteredTasks = f ? brain.tasks.filter((t) => matches(f, t.description)) : brain.tasks;
	if (filteredTasks.length > 0) {
		const pending = filteredTasks.filter((t) => t.status === "pending");
		const done = filteredTasks.filter((t) => t.status === "done");
		const count = f ? `${filteredTasks.length}/${brain.tasks.length} match` : `${pending.length} pending, ${done.length} done`;
		let s = `# Tasks (${count})\n\n`;
		for (const t of pending) {
			const pri = t.priority !== "normal" ? ` (${t.priority})` : "";
			const due = t.due ? ` due:${t.due}` : "";
			if (detailed) {
				const tags = t.tags?.length ? ` tags:${t.tags.join(",")}` : "";
				s += `- [ ] [${t.id}] ${t.description}${pri}${due}  \`[${fmtDate(t.created)}${tags}]\`\n`;
			} else {
				s += `- [ ] [${t.id}] ${t.description}${pri}${due}\n`;
			}
		}
		for (const t of done) {
			if (detailed) {
				const completed = t.completedAt ? `completed:${fmtDate(t.completedAt)}` : "";
				const tags = t.tags?.length ? ` tags:${t.tags.join(",")}` : "";
				s += `- [x] [${t.id}] ${t.description}  \`[${completed}${tags}]\`\n`;
			} else {
				s += `- [x] [${t.id}] ${t.description}\n`;
			}
		}
		sections.push(s);
	}

	// Meta section
	const filteredMeta = f ? [...brain.meta].filter(([k, e]) => matches(f, k, e.value)) : [...brain.meta];
	if (filteredMeta.length > 0) {
		const count = f ? `${filteredMeta.length}/${brain.meta.size} match` : `${brain.meta.size}`;
		let s = `# Meta (${count})\n`;
		for (const [key, entry] of filteredMeta) {
			s += `- ${key}: ${entry.value}\n`;
		}
		sections.push(s);
	}

	// Tombstone count
	if (brain.tombstoned.size > 0) {
		sections.push(`*${brain.tombstoned.size} entries tombstoned*`);
	}

	return sections.join("\n\n---\n\n");
}

// Strip ANSI escape codes to get visible text
function stripAnsi(s: string): string {
	return s.replace(/\x1b\[[0-9;]*m|\x1b\]8;[^;]*;[^\x1b]*\x1b\\|\x1b\[[0-9]*[A-Za-z]/g, "");
}

class MemoryViewerComponent {
	private scrollOffset = 0;
	private allLines: string[] = [];
	private sectionOffsets: { name: string; line: number }[] = [];
	private lastWidth = 0;
	private md: Markdown;
	private disposed = false;
	private detailed = false;
	private filterMode = false;   // input visible and focused
	private filterText = "";      // active filter (persists after Enter)
	private searchInput: Input | null = null;

	constructor(
		private tui: TUI,
		private theme: Theme,
		private done: () => void,
	) {
		const content = buildMarkdown(this.detailed);
		this.md = new Markdown(content, 1, 0, getMarkdownTheme());
	}

	private refresh(): void {
		const content = buildMarkdown(this.detailed, this.filterText);
		this.md = new Markdown(content, 1, 0, getMarkdownTheme());
		this.lastWidth = 0; // force re-render
		this.sectionOffsets = [];
		const maxScroll = Math.max(0, this.allLines.length - this.visibleLines());
		if (this.scrollOffset > maxScroll) this.scrollOffset = maxScroll;
		this.tui.requestRender();
	}

	private computeSectionOffsets(): void {
		this.sectionOffsets = [];
		for (let i = 0; i < this.allLines.length; i++) {
			const visible = stripAnsi(this.allLines[i]).trim();
			// Markdown renders # headings as styled text — match lines that look like section headers
			if (/^(Behavior|Identity|User|Preferences|Context|Learnings|Reminders|Tasks|Meta)\s*\(/.test(visible)) {
				this.sectionOffsets.push({ name: visible.split("(")[0].trim(), line: i });
			}
		}
	}

	private jumpToNextSection(): void {
		if (this.sectionOffsets.length === 0) return;
		const next = this.sectionOffsets.find((s) => s.line > this.scrollOffset);
		this.scrollOffset = next ? next.line : this.sectionOffsets[0].line; // wrap to top
		this.tui.requestRender();
	}

	private jumpToPrevSection(): void {
		if (this.sectionOffsets.length === 0) return;
		// Find last section before current scroll position
		let prev: { name: string; line: number } | undefined;
		for (const s of this.sectionOffsets) {
			if (s.line < this.scrollOffset) prev = s;
		}
		this.scrollOffset = prev ? prev.line : this.sectionOffsets[this.sectionOffsets.length - 1].line; // wrap to bottom
		this.tui.requestRender();
	}

	private enterFilterMode(): void {
		if (!this.searchInput) {
			this.searchInput = new Input();
			this.searchInput.onSubmit = () => {
				// Enter: keep filter, hide input, return to scroll
				this.filterText = this.searchInput!.getValue();
				this.filterMode = false;
				this.refresh();
			};
			this.searchInput.onEscape = () => {
				// Esc: clear filter entirely
				this.filterText = "";
				this.filterMode = false;
				this.searchInput!.setValue("");
				this.scrollOffset = 0;
				this.refresh();
			};
		}
		this.searchInput.setValue(this.filterText);
		this.filterMode = true;
		this.tui.requestRender();
	}

	handleInput(data: string): void {
		if (this.disposed) return;

		// Filter mode: route input to search input
		if (this.filterMode && this.searchInput) {
			this.searchInput.handleInput(data);
			// Live filter: check if value changed
			const newVal = this.searchInput.getValue();
			if (newVal !== this.filterText) {
				this.filterText = newVal;
				this.scrollOffset = 0;
				this.refresh();
			}
			this.tui.requestRender();
			return;
		}

		const pageSize = Math.max(1, this.visibleLines() - 2);
		const maxScroll = Math.max(0, this.allLines.length - this.visibleLines());

		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
			// If filter is active (but input hidden), first clear filter
			if (this.filterText) {
				this.filterText = "";
				if (this.searchInput) this.searchInput.setValue("");
				this.scrollOffset = 0;
				this.refresh();
				return;
			}
			this.disposed = true;
			this.done();
		} else if (matchesKey(data, "/")) {
			this.enterFilterMode();
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
		} else if (matchesKey(data, Key.tab)) {
			this.jumpToNextSection();
		} else if (matchesKey(data, Key.shift("tab"))) {
			this.jumpToPrevSection();
		} else if (matchesKey(data, "r")) {
			this.refresh();
		} else if (matchesKey(data, "d")) {
			this.detailed = !this.detailed;
			this.refresh();
		}
	}

	private visibleLines(): number {
		// Overlay is capped at 70% of terminal height
		const maxOverlay = Math.floor(process.stdout.rows * 0.7);
		// Reserve: top border (1) + bottom border (1) + optional search input
		const chrome = 2 + (this.filterMode ? 1 : 0);
		return Math.max(1, maxOverlay - chrome);
	}

	render(width: number): string[] {
		const th = this.theme;
		const innerW = Math.max(1, width - 2);

		// Re-render markdown if width changed
		if (width !== this.lastWidth) {
			this.lastWidth = width;
			this.allLines = this.md.render(innerW);
			this.computeSectionOffsets();
		}

		const visible = this.visibleLines();
		const maxScroll = Math.max(0, this.allLines.length - visible);

		// Clamp scroll
		if (this.scrollOffset > maxScroll) this.scrollOffset = maxScroll;

		const border = (c: string) => th.fg("border", c);
		const accent = (c: string) => th.fg("accent", c);
		const dim = (c: string) => th.fg("dim", c);
		const result: string[] = [];

		// ── Top border: title + scroll info ──
		const total = this.allLines.length;
		const pos = total > 0 ? Math.floor(((this.scrollOffset + visible / 2) / Math.max(1, total)) * 100) : 0;
		const pct = `${Math.min(pos, 100)}%`;
		const titleLeft = ` Memories `;
		const filterTag = (!this.filterMode && this.filterText) ? ` filter: "${this.filterText}" ` : "";
		const detailTag = this.detailed ? " detailed " : "";
		const titleRight = ` ${[pct, detailTag, filterTag].filter(Boolean).join("· ").trim()} `;
		const titleLeftW = visibleWidth(titleLeft);
		const titleRightW = visibleWidth(titleRight);
		const fillW = Math.max(0, innerW - titleLeftW - titleRightW);
		result.push(
			border("╭") +
				accent(titleLeft) +
				border("─".repeat(fillW)) +
				dim(titleRight) +
				border("╮"),
		);

		// ── Search input (only when filter mode active) ──
		if (this.filterMode && this.searchInput) {
			const inputLines = this.searchInput.render(innerW - 4);
			const inputLine = inputLines[0] || "";
			result.push(
				border("│") +
					truncateToWidth(accent(" / ") + inputLine, innerW, "", true) +
					border("│"),
			);
		}

		// ── Content lines ──
		const visibleSlice = this.allLines.slice(this.scrollOffset, this.scrollOffset + visible);
		for (const line of visibleSlice) {
			result.push(border("│") + truncateToWidth(line, innerW, "…", true) + border("│"));
		}

		// Pad if content is shorter than visible area
		for (let i = visibleSlice.length; i < visible; i++) {
			result.push(border("│") + " ".repeat(innerW) + border("│"));
		}

		// ── Bottom border: keybind hints ──
		const hint = (key: string, desc: string) => th.fg("dim", key) + th.fg("muted", " " + desc);
		const sep = th.fg("border", " · ");

		const hints = this.filterMode
			? [hint("type", "filter"), hint("enter", "keep"), hint("esc", "clear")]
			: [
					hint("↑↓ jk", "scroll"),
					hint("PgUp/Dn", "page"),
					hint("g/G", "top/end"),
					hint("Tab", "section"),
					hint("/", "search"),
					hint("d", "detail"),
					hint("r", "refresh"),
					hint("Esc", "close"),
				];
		const hintsStr = " " + hints.join(sep) + " ";
		const hintsW = visibleWidth(hintsStr);
		const hintFill = Math.max(0, innerW - hintsW);
		result.push(
			border("╰") +
				hintsStr +
				border("─".repeat(hintFill)) +
				border("╯"),
		);

		return result;
	}

	invalidate(): void {
		this.lastWidth = 0; // Force re-render of markdown
		this.md.invalidate();
	}
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("memories", {
		description: "View all brain memories in a scrollable overlay",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("memories requires interactive mode", "error");
				return;
			}

			await ctx.ui.custom<void>(
				(tui, theme, _kb, done) => new MemoryViewerComponent(tui, theme, done),
				{
					overlay: true,
					overlayOptions: {
						anchor: "center",
						width: "70%",
						minWidth: 50,
						maxHeight: "70%",
					},
				},
			);
		},
	});
}
