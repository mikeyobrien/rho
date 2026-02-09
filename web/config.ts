import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export type KnownFileCategory = "core" | "brain" | "config";

export interface KnownFile {
  id: string;
  name: string;
  category: KnownFileCategory;
  path: string;
  isDirectory?: boolean;
}

export function getRhoHome(): string {
  return process.env.RHO_HOME ?? path.join(os.homedir(), ".rho");
}

export function getKnownFiles(): KnownFile[] {
  const rhoHome = getRhoHome();
  const brainDir = path.join(rhoHome, "brain");
  const vaultDb = path.join(brainDir, "vault.db");
  const vaultDir = path.join(brainDir, "vault");

  const files: KnownFile[] = [
    { id: "rho-md", name: "RHO.md", category: "core", path: path.join(rhoHome, "RHO.md") },
    { id: "soul-md", name: "SOUL.md", category: "core", path: path.join(rhoHome, "SOUL.md") },
    { id: "agents-md", name: "AGENTS.md", category: "core", path: path.join(rhoHome, "AGENTS.md") },
    { id: "memory-jsonl", name: "memory.jsonl", category: "brain", path: path.join(brainDir, "memory.jsonl") },
    { id: "tasks-jsonl", name: "tasks.jsonl", category: "brain", path: path.join(brainDir, "tasks.jsonl") },
    { id: "init-toml", name: "init.toml", category: "config", path: path.join(rhoHome, "init.toml") },
  ];

  if (existsSync(vaultDir) && !existsSync(vaultDb)) {
    files.push({ id: "vault-dir", name: "vault", category: "brain", path: vaultDir, isDirectory: true });
  } else {
    files.push({ id: "vault-db", name: "vault.db", category: "brain", path: vaultDb });
  }

  return files;
}

export function findKnownFileByPath(candidatePath: string): KnownFile | null {
  const normalized = path.resolve(candidatePath);
  const files = getKnownFiles();

  for (const file of files) {
    if (path.resolve(file.path) === normalized) {
      return file;
    }
  }

  return null;
}
