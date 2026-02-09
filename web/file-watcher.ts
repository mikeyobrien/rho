import { existsSync, watch } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { getKnownFiles } from "./config.ts";

export interface WatchedFile {
  name: string;
  category: string;
  path: string;
  lastModified: string;
  content?: string;
  isDirectory?: boolean;
}

type ChangeHandler = (filePath: string, content: string) => void;

export class FileWatcher {
  private watchers = new Map<string, ReturnType<typeof watch>>();
  private handlers = new Set<ChangeHandler>();
  private debounceTimers = new Map<string, NodeJS.Timeout>();

  start(): void {
    const files = getKnownFiles();
    for (const file of files) {
      this.watchFile(file.path);
    }
  }

  stop(): void {
    for (const watcher of this.watchers.values()) {
      watcher.close();
    }
    this.watchers.clear();
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
  }

  onChange(handler: ChangeHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  async getFiles(): Promise<WatchedFile[]> {
    const files = getKnownFiles();
    const results: WatchedFile[] = [];

    for (const file of files) {
      try {
        const info = await stat(file.path);
        const lastModified = info.mtime.toISOString();

        if (info.isDirectory()) {
          results.push({
            name: file.name,
            category: file.category,
            path: file.path,
            lastModified,
            isDirectory: true,
          });
          continue;
        }

        const content = await readFile(file.path, "utf-8");
        results.push({
          name: file.name,
          category: file.category,
          path: file.path,
          lastModified,
          content,
        });
      } catch {
        // Missing or unreadable files are skipped.
      }
    }

    return results;
  }

  private watchFile(filePath: string): void {
    if (this.watchers.has(filePath)) {
      return;
    }

    const target = this.resolveWatchTarget(filePath);
    if (!target) {
      return;
    }

    try {
      const watcher = watch(target, { persistent: false }, () => {
        this.queueChange(filePath);
      });
      this.watchers.set(filePath, watcher);
    } catch {
      // Ignore watcher failures (e.g., missing directories).
    }
  }

  private resolveWatchTarget(filePath: string): string | null {
    if (existsSync(filePath)) {
      return filePath;
    }

    const parent = path.dirname(filePath);
    if (existsSync(parent)) {
      return parent;
    }

    return null;
  }

  private queueChange(filePath: string): void {
    const existing = this.debounceTimers.get(filePath);
    if (existing) {
      clearTimeout(existing);
    }

    const timer = setTimeout(() => {
      this.debounceTimers.delete(filePath);
      void this.emitChange(filePath);
    }, 100);

    this.debounceTimers.set(filePath, timer);
  }

  private async emitChange(filePath: string): Promise<void> {
    try {
      const info = await stat(filePath);
      if (info.isDirectory()) {
        return;
      }
      const content = await readFile(filePath, "utf-8");
      for (const handler of this.handlers) {
        handler(filePath, content);
      }
    } catch {
      // File missing or unreadable.
    }
  }
}
