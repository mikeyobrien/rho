/**
 * Brain Extension - JSONL-based persistent memory for agents
 *
 * Structure:
 *   ~/.pi/brain/core.jsonl     - identity, behavior, user (rarely changes)
 *   ~/.pi/brain/memory.jsonl   - learnings, preferences (grows, has lifecycle)
 *   ~/.pi/brain/context.jsonl  - project contexts (matched by cwd)
 *   ~/.pi/brain/archive.jsonl  - decayed entries
 *   ~/.pi/brain/memory/YYYY-MM-DD.md - daily markdown memory log
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";

// Paths
const BRAIN_DIR = path.join(os.homedir(), ".pi", "brain");
const CORE_FILE = path.join(BRAIN_DIR, "core.jsonl");
const MEMORY_FILE = path.join(BRAIN_DIR, "memory.jsonl");
const CONTEXT_FILE = path.join(BRAIN_DIR, "context.jsonl");
const ARCHIVE_FILE = path.join(BRAIN_DIR, "archive.jsonl");

// Types
interface BaseEntry {
  id: string;
  type: string;
  created: string;
}

interface IdentityEntry extends BaseEntry {
  type: "identity";
  key: string;
  value: string;
}

interface BehaviorEntry extends BaseEntry {
  type: "behavior";
  category: "do" | "dont" | "value";
  text: string;
}

interface UserEntry extends BaseEntry {
  type: "user";
  key: string;
  value: string;
}

interface LearningEntry extends BaseEntry {
  type: "learning";
  text: string;
  used: number;
  last_used: string;
  source?: string; // what triggered this learning
}

interface PreferenceEntry extends BaseEntry {
  type: "preference";
  category: string;
  text: string;
}

interface ContextEntry extends BaseEntry {
  type: "context";
  project: string;
  path: string;
  content: string;
}

type Entry = IdentityEntry | BehaviorEntry | UserEntry | LearningEntry | PreferenceEntry | ContextEntry;

// Helpers
function nanoid(size = 8): string {
  return crypto.randomBytes(size).toString("base64url").slice(0, size);
}

function today(): string {
  return new Date().toISOString().split("T")[0];
}

function ensureDir(): void {
  if (!fs.existsSync(BRAIN_DIR)) {
    fs.mkdirSync(BRAIN_DIR, { recursive: true });
  }
}

function readJsonl<T>(file: string): T[] {
  if (!fs.existsSync(file)) return [];
  const content = fs.readFileSync(file, "utf-8");
  return content
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as T);
}

function appendJsonl<T>(file: string, entry: T): void {
  ensureDir();
  fs.appendFileSync(file, JSON.stringify(entry) + "\n");
}

function writeJsonl<T>(file: string, entries: T[]): void {
  ensureDir();
  fs.writeFileSync(file, entries.map((e) => JSON.stringify(e)).join("\n") + (entries.length ? "\n" : ""));
}

// Bootstrap from defaults
function bootstrapDefaults(extensionDir: string): void {
  const defaultsDir = path.join(path.dirname(extensionDir), "brain");
  if (!fs.existsSync(defaultsDir)) return;

  ensureDir();
  for (const file of fs.readdirSync(defaultsDir)) {
    if (!file.endsWith(".jsonl.default")) continue;
    const target = path.join(BRAIN_DIR, file.replace(".default", ""));
    if (!fs.existsSync(target)) {
      fs.copyFileSync(path.join(defaultsDir, file), target);
    }
  }
}

// Build context for system prompt
function buildBrainContext(cwd: string): string {
  const sections: string[] = [];

  // Core entries
  const core = readJsonl<Entry>(CORE_FILE);

  // Identity
  const identity = core.filter((e): e is IdentityEntry => e.type === "identity");
  if (identity.length > 0) {
    sections.push("## Identity\n" + identity.map((e) => `- ${e.key}: ${e.value}`).join("\n"));
  }

  // User
  const user = core.filter((e): e is UserEntry => e.type === "user");
  if (user.length > 0) {
    sections.push("## User\n" + user.map((e) => `- ${e.key}: ${e.value}`).join("\n"));
  }

  // Behavior - compact format
  const behaviors = core.filter((e): e is BehaviorEntry => e.type === "behavior");
  if (behaviors.length > 0) {
    const dos = behaviors.filter((b) => b.category === "do").map((b) => b.text);
    const donts = behaviors.filter((b) => b.category === "dont").map((b) => b.text);
    const values = behaviors.filter((b) => b.category === "value").map((b) => b.text);

    let behaviorSection = "## Behavior\n";
    if (dos.length > 0) behaviorSection += `**Do:** ${dos.join(". ")}.\n`;
    if (donts.length > 0) behaviorSection += `**Don't:** ${donts.join(". ")}.\n`;
    if (values.length > 0) behaviorSection += `**Values:** ${values.join(". ")}.`;
    sections.push(behaviorSection.trim());
  }

  // Memory (learnings + preferences) - only if non-empty
  const memory = readJsonl<Entry>(MEMORY_FILE);
  const learnings = memory.filter((e): e is LearningEntry => e.type === "learning");
  const preferences = memory.filter((e): e is PreferenceEntry => e.type === "preference");

  if (learnings.length > 0) {
    // Sort by usage (most used first), then by recency
    const sorted = [...learnings].sort((a, b) => {
      if (b.used !== a.used) return b.used - a.used;
      return b.last_used.localeCompare(a.last_used);
    });
    sections.push("## Learnings\n" + sorted.map((l) => `- ${l.text}`).join("\n"));
  }

  if (preferences.length > 0) {
    const byCategory = new Map<string, string[]>();
    for (const p of preferences) {
      const list = byCategory.get(p.category) || [];
      list.push(p.text);
      byCategory.set(p.category, list);
    }
    let prefSection = "## Preferences\n";
    for (const [cat, items] of byCategory) {
      prefSection += `**${cat}:** ${items.join(". ")}.\n`;
    }
    sections.push(prefSection.trim());
  }

  // Context (matched by cwd)
  const contexts = readJsonl<ContextEntry>(CONTEXT_FILE);
  const matched = contexts.find((c) => cwd.startsWith(c.path));
  if (matched) {
    sections.push(`## Project: ${matched.project}\n\n${matched.content}`);
  }

  return sections.join("\n\n");
}

// Concise memory instructions with examples
const MEMORY_INSTRUCTIONS = `## Memory

You have persistent memory via the \`memory\` tool. Store insights that help future sessions.

**Store when:**
- User corrects you → learning
- You discover a pattern/convention → learning  
- User states a preference → preference with category

**Good learnings:** "User prefers early returns over nested ifs", "This repo uses pnpm not npm", "API uses snake_case"
**Bad learnings:** "User asked about X", "Fixed a bug", "Session went well"

**Don't store:** obvious things, duplicates, session-specific details.`.trim();

export default function (pi: ExtensionAPI) {
  // Bootstrap on load
  bootstrapDefaults(__dirname);

  // Update widget on session start
  pi.on("session_start", async (_event, ctx) => {
    updateBrainWidget(ctx);
  });

  // Inject brain context into system prompt
  pi.on("before_agent_start", async (event, ctx) => {
    const brainContext = buildBrainContext(ctx.cwd);
    if (brainContext.trim()) {
      return {
        systemPrompt: event.systemPrompt + "\n\n# Memory\n\n" + MEMORY_INSTRUCTIONS + "\n\n" + brainContext,
      };
    }
  });

  // Helper to update brain widget
  function updateBrainWidget(ctx: { ui?: { setStatus?: (id: string, text: string | undefined) => void } }) {
    if (!ctx?.ui?.setStatus) return;
    
    const memory = readJsonl<Entry>(MEMORY_FILE);
    const contexts = readJsonl<ContextEntry>(CONTEXT_FILE);
    const learnings = memory.filter((e) => e.type === "learning").length;
    const prefs = memory.filter((e) => e.type === "preference").length;
    const matched = contexts.find((c) => process.cwd().startsWith(c.path));

    let status = `🧠 ${learnings}L ${prefs}P`;
    if (matched) {
      status += ` · ${matched.project}`;
    }
    ctx.ui.setStatus("brain", status);
  }

  // Register memory tool with clear, specific description
  pi.registerTool({
    name: "memory",
    label: "Memory",
    description:
      "Store learnings (corrections, patterns, conventions) or preferences (user likes/dislikes with category). Use after user corrections or when discovering something future sessions need. Actions: add_learning, add_preference, reinforce, search, list.",
    parameters: Type.Object({
      action: StringEnum(["add_learning", "add_preference", "reinforce", "search", "list"] as const),
      content: Type.Optional(Type.String({ description: "Concise, actionable text" })),
      category: Type.Optional(Type.String({ description: "Category: Communication, Code, Tools, Workflow" })),
      query: Type.Optional(Type.String({ description: "Search query" })),
      id: Type.Optional(Type.String({ description: "Entry ID for reinforce" })),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      switch (params.action) {
        case "add_learning": {
          if (!params.content) {
            return { content: [{ type: "text", text: "Error: content required" }], details: { error: true } };
          }
          // Check for duplicates
          const existing = readJsonl<Entry>(MEMORY_FILE);
          const isDupe = existing.some(
            (e) => e.type === "learning" && (e as LearningEntry).text.toLowerCase() === params.content!.toLowerCase()
          );
          if (isDupe) {
            return {
              content: [{ type: "text", text: "Already stored" }],
              details: { duplicate: true },
            };
          }
          const entry: LearningEntry = {
            id: nanoid(),
            type: "learning",
            text: params.content,
            used: 0,
            last_used: today(),
            created: today(),
          };
          appendJsonl(MEMORY_FILE, entry);
          updateBrainWidget(ctx);
          return {
            content: [{ type: "text", text: `Stored: ${params.content}` }],
            details: { id: entry.id },
          };
        }

        case "add_preference": {
          if (!params.content) {
            return { content: [{ type: "text", text: "Error: content required" }], details: { error: true } };
          }
          const category = params.category || "General";
          // Check for duplicates
          const existing = readJsonl<Entry>(MEMORY_FILE);
          const isDupe = existing.some(
            (e) =>
              e.type === "preference" &&
              (e as PreferenceEntry).text.toLowerCase() === params.content!.toLowerCase() &&
              (e as PreferenceEntry).category === category
          );
          if (isDupe) {
            return {
              content: [{ type: "text", text: "Already stored" }],
              details: { duplicate: true },
            };
          }
          const entry: PreferenceEntry = {
            id: nanoid(),
            type: "preference",
            category,
            text: params.content,
            created: today(),
          };
          appendJsonl(MEMORY_FILE, entry);
          updateBrainWidget(ctx);
          return {
            content: [{ type: "text", text: `Stored [${category}]: ${params.content}` }],
            details: { id: entry.id },
          };
        }

        case "reinforce": {
          if (!params.id) {
            return { content: [{ type: "text", text: "Error: id required" }], details: { error: true } };
          }
          const entries = readJsonl<Entry>(MEMORY_FILE);
          const idx = entries.findIndex((e) => e.id === params.id);
          if (idx === -1) {
            return { content: [{ type: "text", text: "Entry not found" }], details: { error: true } };
          }
          const entry = entries[idx];
          if (entry.type === "learning") {
            (entry as LearningEntry).used++;
            (entry as LearningEntry).last_used = today();
          }
          writeJsonl(MEMORY_FILE, entries);
          return {
            content: [{ type: "text", text: `Reinforced: ${(entry as LearningEntry).text}` }],
            details: { id: entry.id, used: (entry as LearningEntry).used },
          };
        }

        case "search": {
          const query = (params.query || "").toLowerCase();
          const memory = readJsonl<Entry>(MEMORY_FILE);
          const matches = memory.filter((e) => {
            if (e.type === "learning") return (e as LearningEntry).text.toLowerCase().includes(query);
            if (e.type === "preference") return (e as PreferenceEntry).text.toLowerCase().includes(query);
            return false;
          });
          return {
            content: [
              {
                type: "text",
                text: matches.length
                  ? matches.map((m) => `[${m.id}] ${(m as LearningEntry | PreferenceEntry).text}`).join("\n")
                  : "No matches",
              },
            ],
            details: { count: matches.length },
          };
        }

        case "list": {
          const memory = readJsonl<Entry>(MEMORY_FILE);
          const learnings = memory.filter((e) => e.type === "learning") as LearningEntry[];
          const prefs = memory.filter((e) => e.type === "preference") as PreferenceEntry[];
          let text = `**Learnings (${learnings.length}):**\n`;
          text += learnings.map((l) => `- ${l.text}`).join("\n") || "(none)";
          text += `\n\n**Preferences (${prefs.length}):**\n`;
          text += prefs.map((p) => `- [${p.category}] ${p.text}`).join("\n") || "(none)";
          return { content: [{ type: "text", text }], details: { learnings: learnings.length, preferences: prefs.length } };
        }

        default:
          return { content: [{ type: "text", text: `Unknown action` }], details: { error: true } };
      }
    },
  });

  // Register /brain command
  pi.registerCommand("brain", {
    description: "View brain stats or search (usage: /brain [stats|search <query>])",
    handler: async (args, ctx) => {
      const parts = args?.trim().split(/\s+/) || [];
      const subcmd = parts[0] || "stats";

      if (subcmd === "stats" || !subcmd) {
        const core = readJsonl<Entry>(CORE_FILE);
        const memory = readJsonl<Entry>(MEMORY_FILE);
        const learnings = memory.filter((e) => e.type === "learning").length;
        const prefs = memory.filter((e) => e.type === "preference").length;
        const identity = core.filter((e) => e.type === "identity").length;
        const behaviors = core.filter((e) => e.type === "behavior").length;
        ctx.ui.notify(`🧠 ${learnings}L ${prefs}P | core: ${identity}id ${behaviors}beh`, "info");
      } else if (subcmd === "search") {
        const query = parts.slice(1).join(" ").toLowerCase();
        if (!query) {
          ctx.ui.notify("Usage: /brain search <query>", "error");
          return;
        }
        const memory = readJsonl<Entry>(MEMORY_FILE);
        const matches = memory.filter((e) => {
          if (e.type === "learning") return (e as LearningEntry).text.toLowerCase().includes(query);
          if (e.type === "preference") return (e as PreferenceEntry).text.toLowerCase().includes(query);
          return false;
        });
        ctx.ui.notify(matches.length ? `Found ${matches.length} matches` : "No matches", "info");
      } else {
        ctx.ui.notify("Usage: /brain [stats|search <query>]", "error");
      }
    },
  });
}
