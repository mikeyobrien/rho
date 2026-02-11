import { readFile, readdir, stat } from "node:fs/promises";
import { resolve, relative, extname, join } from "node:path";
import { homedir } from "node:os";
import { glob } from "glob";

export interface ReviewFile {
  path: string;
  relativePath: string;
  content: string;
  language: string;
}

const LANGUAGE_MAP: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".md": "markdown",
  ".py": "python",
  ".rs": "rust",
  ".go": "go",
  ".css": "css",
  ".html": "html",
  ".json": "json",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".sh": "bash",
};

function detectLanguage(filePath: string): string {
  return LANGUAGE_MAP[extname(filePath).toLowerCase()] ?? "plaintext";
}

async function isBinary(filePath: string): Promise<boolean> {
  const fd = await readFile(filePath, { flag: "r" });
  const chunk = fd.subarray(0, 8192);
  return chunk.includes(0);
}

/** Max file size before we skip (500KB). */
const MAX_FILE_SIZE = 500 * 1024;

async function loadFile(
  filePath: string,
  cwd: string,
  warnings?: string[]
): Promise<ReviewFile | null> {
  const abs = resolve(cwd, filePath);
  try {
    if (await isBinary(abs)) {
      const msg = `Skipping binary file: ${abs}`;
      console.warn(msg);
      warnings?.push(msg);
      return null;
    }
    const content = await readFile(abs, "utf-8");
    if (content.length > MAX_FILE_SIZE) {
      const msg = `Skipping large file (${(content.length / 1024).toFixed(0)}KB): ${abs}`;
      console.warn(msg);
      warnings?.push(msg);
      return null;
    }
    let relativePath = relative(cwd, abs);
    if (relativePath.startsWith("../../..")) {
      const homeRel = relative(homedir(), abs);
      if (!homeRel.startsWith("..")) {
        const homePath = "~/" + homeRel;
        if (homePath.length < relativePath.length) relativePath = homePath;
      }
    }
    return {
      path: abs,
      relativePath,
      content,
      language: detectLanguage(abs),
    };
  } catch (err: any) {
    const msg = `Skipping missing file: ${abs} (${err.message})`;
    console.warn(msg);
    warnings?.push(msg);
    return null;
  }
}

function isGlob(input: string): boolean {
  return /[*?]/.test(input) || input.includes("**");
}

export interface ResolveResult {
  files: ReviewFile[];
  warnings: string[];
}

export async function resolveFiles(
  input: string[],
  cwd: string
): Promise<ResolveResult> {
  const files: ReviewFile[] = [];
  const warnings: string[] = [];

  for (const entry of input) {
    if (isGlob(entry)) {
      const matches = await glob(entry, { cwd, nodir: true });
      for (const match of matches) {
        const f = await loadFile(match, cwd, warnings);
        if (f) files.push(f);
      }
      continue;
    }

    const abs = resolve(cwd, entry);
    let info;
    try {
      info = await stat(abs);
    } catch {
      const msg = `Skipping missing path: ${abs}`;
      console.warn(msg);
      warnings.push(msg);
      continue;
    }

    if (info.isDirectory()) {
      const entries = await readdir(abs);
      for (const child of entries) {
        const childPath = join(abs, child);
        const childStat = await stat(childPath).catch(() => null);
        if (childStat?.isFile()) {
          const f = await loadFile(childPath, cwd, warnings);
          if (f) files.push(f);
        }
      }
    } else if (info.isFile()) {
      const f = await loadFile(abs, cwd, warnings);
      if (f) files.push(f);
    }
  }

  return { files, warnings };
}
