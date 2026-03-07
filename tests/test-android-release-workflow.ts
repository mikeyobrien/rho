import fs from "node:fs";

let PASS = 0;
let FAIL = 0;

function assert(condition: boolean, label: string): void {
	if (condition) {
		console.log(`  PASS: ${label}`);
		PASS++;
		return;
	}
	console.error(`  FAIL: ${label}`);
	FAIL++;
}

const workflow = fs.readFileSync(
	".github/workflows/android-release.yml",
	"utf8",
);

console.log("\n=== Android Release Workflow Checks ===\n");

assert(
	/name:\s*Build Signed APK/.test(workflow),
	"includes Build Signed APK step",
);
assert(
	/run:\s*\.\/gradlew\s+assembleRelease/.test(workflow),
	"runs Gradle assembleRelease task",
);
assert(
	/working-directory:\s*mobile\/rho-android\/android\/app\/build\/outputs\/apk\/release/.test(
		workflow,
	),
	"verifies artifacts from APK release output directory",
);
assert(
	/mobile\/rho-android\/android\/app\/build\/outputs\/apk\/release\/app-release\.apk/.test(
		workflow,
	),
	"uploads app-release.apk as workflow artifact",
);
assert(
	/name:\s*Ensure GitHub Release/.test(workflow),
	"includes release creation step",
);
assert(
	/if:\s*startsWith\(github\.ref,\s*'refs\/tags\/'\)/.test(workflow),
	"only creates releases for tag refs",
);
assert(
	/gh release create "\$TAG_NAME"/.test(workflow),
	"creates GitHub release via gh cli",
);
assert(
	/PRERELEASE_ARGS\+=\(--prerelease\)/.test(workflow),
	"marks rc tags as prereleases",
);
assert(
	/gh release upload "\$TAG_NAME"/.test(workflow),
	"uploads assets to the GitHub release",
);
assert(
	/rho-\$\{TAG_NAME\}\.apk/.test(workflow),
	"uploads renamed APK release asset",
);
assert(
	/rho-\$\{TAG_NAME\}\.aab/.test(workflow),
	"uploads renamed AAB release asset",
);

console.log(`\n=== Results: ${PASS} passed, ${FAIL} failed ===\n`);
process.exit(FAIL > 0 ? 1 : 0);
