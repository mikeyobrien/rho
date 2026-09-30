/**
 * Rho v2 migration. Run: npx tsx tests/test-standalone-migrate.ts
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { applyMigration, previewMigration } from "../cli/migrate-core.ts";
import { resolveRhoPaths } from "../cli/rho-paths.ts";

let failed = 0;

function assert(condition: boolean, label: string): void {
	if (condition) {
		console.log(`  PASS: ${label}`);
		return;
	}
	failed += 1;
	console.error(`  FAIL: ${label}`);
}

function snapshot(root: string): Map<string, Buffer> {
	const files = new Map<string, Buffer>();
	if (!fs.existsSync(root)) return files;
	const stack = [root];
	while (stack.length > 0) {
		const current = stack.pop();
		if (!current) continue;
		for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
			const full = path.join(current, entry.name);
			if (entry.isDirectory()) stack.push(full);
			else if (entry.isFile()) files.set(full, fs.readFileSync(full));
		}
	}
	return files;
}

function sameSnapshot(
	before: Map<string, Buffer>,
	after: Map<string, Buffer>,
): boolean {
	if (before.size !== after.size) return false;
	for (const [file, bytes] of before) {
		const next = after.get(file);
		if (!next || !next.equals(bytes)) return false;
	}
	return true;
}

const home = fs.mkdtempSync(path.join(os.tmpdir(), "rho-migrate-"));
const paths = resolveRhoPaths(home);
const ordinary = paths.ordinaryPiAgentDir;
const sessionRel = path.join("cwd", "session.jsonl");
const settings = {
	packages: [
		{ source: "npm:other", _managed_by: "user" },
		{ source: "npm:@rhobot-dev/rho", _managed_by: "rho" },
	],
	secret: "do-not-copy",
};
fs.mkdirSync(path.join(ordinary, "sessions", "cwd"), { recursive: true });
fs.mkdirSync(paths.brainDir, { recursive: true });
fs.mkdirSync(paths.vaultDir, { recursive: true });
fs.writeFileSync(
	path.join(ordinary, "settings.json"),
	`${JSON.stringify(settings, null, 2)}\n`,
);
fs.writeFileSync(path.join(ordinary, "auth.json"), '{"token":"secret"}\n');
fs.writeFileSync(
	path.join(ordinary, "sessions", sessionRel),
	"session-bytes\n",
);
fs.writeFileSync(path.join(ordinary, "rho-state.json"), '{"heartbeat":1}\n');
fs.writeFileSync(paths.initToml, 'name = "rho"\n');
fs.writeFileSync(path.join(paths.brainDir, "brain.jsonl"), "brain\n");
fs.writeFileSync(path.join(paths.vaultDir, "note.md"), "vault\n");

const ordinaryBefore = snapshot(ordinary);
const brainBefore = fs.readFileSync(path.join(paths.brainDir, "brain.jsonl"));
const vaultBefore = fs.readFileSync(path.join(paths.vaultDir, "note.md"));
const previewBefore = snapshot(home);
const preview = previewMigration(paths);
const previewAfter = snapshot(home);

assert(sameSnapshot(previewBefore, previewAfter), "preview writes nothing");
assert(preview.rhoPackageDetected, "preview detects Rho package");
assert(
	preview.rhoPackageSource === "npm:@rhobot-dev/rho",
	"preview reports package source",
);
assert(preview.sessionCount === 1, "preview counts sessions");
assert(preview.copiesAuth === false, "preview does not plan auth copy");
assert(!fs.existsSync(paths.authPath), "preview does not create auth");
assert(!fs.existsSync(paths.layoutMarker), "preview does not write marker");

const applied = applyMigration(paths, { now: "2026-09-22T00-00-00Z" });
assert(applied.wroteMarker, "apply writes layout marker");
assert(!fs.existsSync(paths.authPath), "apply does not copy auth");
assert(
	fs.readFileSync(path.join(ordinary, "auth.json"), "utf8") ===
		'{"token":"secret"}\n',
	"ordinary auth unchanged",
);
assert(
	sameSnapshot(ordinaryBefore, snapshot(ordinary)),
	"ordinary Pi unchanged without removal flag",
);
assert(
	fs.readFileSync(path.join(paths.sessionDir, sessionRel), "utf8") ===
		"session-bytes\n",
	"session copied",
);
assert(
	fs.readFileSync(path.join(paths.rhoDir, "rho-state.json"), "utf8") ===
		'{"heartbeat":1}\n',
	"state copied",
);
const isolated = JSON.parse(fs.readFileSync(paths.settingsPath, "utf8")) as {
	packages: unknown[];
	secret?: string;
};
assert(isolated.packages.length === 1, "only Rho package copied");
assert(isolated.secret === undefined, "unrelated settings keys not copied");
assert(
	fs.readFileSync(path.join(paths.brainDir, "brain.jsonl")).equals(brainBefore),
	"brain preserved",
);
assert(
	fs.readFileSync(path.join(paths.vaultDir, "note.md")).equals(vaultBefore),
	"vault preserved",
);
assert(
	fs.existsSync(
		path.join(
			paths.rhoDir,
			"migrate-backups",
			"2026-09-22T00-00-00Z",
			"settings.json",
		),
	),
	"backup written first",
);

const again = applyMigration(paths, { now: "2026-09-22T00-00-01Z" });
const isolatedAgain = JSON.parse(
	fs.readFileSync(paths.settingsPath, "utf8"),
) as { packages: unknown[] };
assert(
	isolatedAgain.packages.length === 1,
	"repeated apply does not duplicate package",
);
assert(
	again.actions.includes("Rho package entry already present"),
	"repeated apply is idempotent",
);
assert(!fs.existsSync(paths.authPath), "repeated apply still skips auth");

const collisionHome = fs.mkdtempSync(
	path.join(os.tmpdir(), "rho-migrate-collision-"),
);
const collisionPaths = resolveRhoPaths(collisionHome);
fs.mkdirSync(path.join(collisionPaths.ordinaryPiAgentDir, "sessions", "cwd"), {
	recursive: true,
});
fs.writeFileSync(
	path.join(collisionPaths.ordinaryPiAgentDir, "settings.json"),
	`${JSON.stringify(settings)}\n`,
);
fs.writeFileSync(
	path.join(collisionPaths.ordinaryPiAgentDir, "sessions", sessionRel),
	"source\n",
);
fs.mkdirSync(path.join(collisionPaths.sessionDir, "cwd"), { recursive: true });
fs.writeFileSync(path.join(collisionPaths.sessionDir, sessionRel), "dest\n");
const sourceBefore = fs.readFileSync(
	path.join(collisionPaths.ordinaryPiAgentDir, "sessions", sessionRel),
);
const destBefore = fs.readFileSync(
	path.join(collisionPaths.sessionDir, sessionRel),
);
const collided = applyMigration(collisionPaths);
assert(
	collided.collisions.some((item) => item.includes("exists and differs")),
	"collision warned",
);
assert(
	fs
		.readFileSync(
			path.join(collisionPaths.ordinaryPiAgentDir, "sessions", sessionRel),
		)
		.equals(sourceBefore),
	"collision leaves source",
);
assert(
	fs
		.readFileSync(path.join(collisionPaths.sessionDir, sessionRel))
		.equals(destBefore),
	"collision leaves destination",
);

const interruptHome = fs.mkdtempSync(
	path.join(os.tmpdir(), "rho-migrate-interrupt-"),
);
const interruptPaths = resolveRhoPaths(interruptHome);
fs.mkdirSync(path.join(interruptPaths.ordinaryPiAgentDir, "sessions", "cwd"), {
	recursive: true,
});
fs.writeFileSync(
	path.join(interruptPaths.ordinaryPiAgentDir, "settings.json"),
	`${JSON.stringify(settings)}\n`,
);
fs.writeFileSync(
	path.join(interruptPaths.ordinaryPiAgentDir, "auth.json"),
	"auth\n",
);
fs.writeFileSync(
	path.join(interruptPaths.ordinaryPiAgentDir, "sessions", sessionRel),
	"session\n",
);
const interruptOrdinary = snapshot(interruptPaths.ordinaryPiAgentDir);
let threw = false;
try {
	applyMigration(interruptPaths, {
		hooks: {
			onCopyFile(rel) {
				if (rel.startsWith("sessions/")) throw new Error("interrupted");
			},
		},
	});
} catch (error) {
	threw = error instanceof Error && error.message === "interrupted";
}
assert(threw, "interruption is surfaced");
assert(
	sameSnapshot(interruptOrdinary, snapshot(interruptPaths.ordinaryPiAgentDir)),
	"interruption leaves ordinary Pi intact",
);
assert(
	!fs.existsSync(path.join(interruptPaths.sessionDir, sessionRel)),
	"interrupted session is not partial",
);
assert(
	!fs.existsSync(interruptPaths.layoutMarker),
	"interruption does not mark layout migrated",
);
assert(
	!fs.existsSync(interruptPaths.authPath),
	"interruption does not copy auth",
);

const removalHome = fs.mkdtempSync(
	path.join(os.tmpdir(), "rho-migrate-remove-"),
);
const removalPaths = resolveRhoPaths(removalHome);
fs.mkdirSync(removalPaths.ordinaryPiAgentDir, { recursive: true });
fs.writeFileSync(
	path.join(removalPaths.ordinaryPiAgentDir, "settings.json"),
	`${JSON.stringify(settings, null, 2)}\n`,
);
applyMigration(removalPaths, { removePackage: true, now: "remove" });
const removed = JSON.parse(
	fs.readFileSync(
		path.join(removalPaths.ordinaryPiAgentDir, "settings.json"),
		"utf8",
	),
) as {
	packages: Array<{ source: string }>;
};
assert(removed.packages.length === 1, "removal keeps other packages");
assert(
	removed.packages[0]?.source === "npm:other",
	"removal drops only Rho package",
);
assert(
	fs.existsSync(
		path.join(removalPaths.rhoDir, "migrate-backups", "remove", "settings.json"),
	),
	"removal backs up ordinary settings first",
);

if (failed > 0) {
	console.error(`\n${failed} failed`);
	process.exit(1);
}
console.log("\nstandalone migrate: ok");
