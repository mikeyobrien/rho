import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseToml } from "smol-toml";

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

function resolveProjectsDir(raw: unknown): string {
	const home = process.env.HOME ?? os.homedir();
	const fallback = path.join(getRhoHome(), "projects");
	if (typeof raw !== "string" || !raw.trim()) {
		return fallback;
	}
	const value = raw.trim();
	if (value === "~") {
		return home;
	}
	if (value.startsWith("~/")) {
		return path.resolve(home, value.slice(2));
	}
	return path.resolve(value);
}

export function getProjectsDir(): string {
	const initPath = path.join(getRhoHome(), "init.toml");
	try {
		const raw = parseToml(readFileSync(initPath, "utf-8")) as Record<
			string,
			unknown
		>;
		return resolveProjectsDir(raw.projects_dir);
	} catch {
		return resolveProjectsDir(undefined);
	}
}

export function getKnownFiles(): KnownFile[] {
	const rhoHome = getRhoHome();
	const brainDir = path.join(rhoHome, "brain");
	const vaultDb = path.join(brainDir, "vault.db");
	const vaultDir = path.join(brainDir, "vault");

	const files: KnownFile[] = [
		{
			id: "brain-jsonl",
			name: "brain.jsonl",
			category: "brain",
			path: path.join(brainDir, "brain.jsonl"),
		},
		{
			id: "init-toml",
			name: "init.toml",
			category: "config",
			path: path.join(rhoHome, "init.toml"),
		},
	];

	if (existsSync(vaultDir) && !existsSync(vaultDb)) {
		files.push({
			id: "vault-dir",
			name: "vault",
			category: "brain",
			path: vaultDir,
			isDirectory: true,
		});
	} else {
		files.push({
			id: "vault-db",
			name: "vault.db",
			category: "brain",
			path: vaultDb,
		});
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
