import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TEST_DIR =
	import.meta.dirname ?? path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(TEST_DIR, "../web");
const LIMIT = 500;
const EXTENSIONS = new Set([".ts", ".js"]);

function collectFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.name === "node_modules" || entry.name === ".git") continue;
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			out.push(...collectFiles(full));
			continue;
		}
		if (!entry.isFile()) continue;
		const ext = path.extname(entry.name);
		if (!EXTENSIONS.has(ext)) continue;
		out.push(full);
	}
	return out;
}

function lineCount(filePath: string): number {
	const content = readFileSync(filePath, "utf8");
	if (content.length === 0) return 0;
	return content.split("\n").length;
}

const files = collectFiles(ROOT);
const offenders = files
	.map((filePath) => ({
		filePath,
		lines: lineCount(filePath),
		size: statSync(filePath).size,
	}))
	.filter((item) => item.lines > LIMIT)
	.sort((a, b) => b.lines - a.lines);

console.log(`Checked ${files.length} web .ts/.js files (limit ${LIMIT} lines)`);

if (offenders.length > 0) {
	console.error("\nFiles over line limit:");
	for (const offender of offenders) {
		const rel = path.relative(path.resolve(TEST_DIR, ".."), offender.filePath);
		console.error(
			` - ${rel}: ${offender.lines} lines (${offender.size} bytes)`,
		);
	}
	process.exit(1);
}

console.log("PASS web line limit");
