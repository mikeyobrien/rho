/**
 * rho migrate — preview or apply an isolated layout conversion.
 */
import { applyMigration, previewMigration } from "../migrate-core.ts";
import { resolveRhoPaths } from "../rho-paths.ts";

function printReport(
	title: string,
	report: ReturnType<typeof previewMigration>,
): void {
	console.log(title);
	console.log(`  settings: ${report.sourceSettings} -> ${report.destSettings}`);
	console.log(`  sessions: ${report.sourceSessions} -> ${report.destSessions}`);
	console.log(`  auth: ${report.sourceAuth} -> ${report.destAuth}`);
	console.log(
		`  Rho package: ${report.rhoPackageDetected ? (report.rhoPackageSource ?? "detected") : "not found"}`,
	);
	console.log(`  sessions found: ${report.sessionCount}`);
	console.log(`  copy auth: ${report.copiesAuth ? "yes" : "no"}`);
	console.log(`  remove package: ${report.removesPackage ? "yes" : "no"}`);
	if (report.collisions.length > 0) {
		console.log("  collisions:");
		for (const collision of report.collisions) console.log(`    - ${collision}`);
	}
	if (report.actions.length > 0) {
		console.log("  actions:");
		for (const action of report.actions) console.log(`    - ${action}`);
	}
}

export async function run(args: string[]): Promise<void> {
	if (args.includes("--help") || args.includes("-h")) {
		console.log(`rho migrate [--apply] [--copy-auth] [--remove-package]

Preview an isolated Rho migration. Nothing is written unless --apply is set.
Auth is not copied unless --copy-auth is also set.
The ordinary Pi package entry is removed only with --apply --remove-package.`);
		return;
	}

	const options = {
		copyAuth: args.includes("--copy-auth"),
		removePackage: args.includes("--remove-package"),
	};
	const paths = resolveRhoPaths();
	if (!args.includes("--apply")) {
		printReport(
			"Migration preview (no files written):",
			previewMigration(paths, options),
		);
		console.log("Run `rho migrate --apply` to copy Rho settings and sessions.");
		return;
	}

	const report = applyMigration(paths, options);
	printReport("Migration applied:", report);
	if (!options.copyAuth) {
		console.log(
			"Credentials were not copied. Run `rho login` for isolated auth.",
		);
	}
}
