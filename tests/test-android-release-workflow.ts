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
	/name:\s*Build Signed AAB/.test(workflow),
	"includes Build Signed AAB step",
);
assert(
	/name:\s*Build Signed AAB[\s\S]*?run:\s*\.\/gradlew\s+:app:bundleRelease/.test(
		workflow,
	),
	"runs module-scoped Gradle :app:bundleRelease task",
);
assert(
	/name:\s*Build Signed APK/.test(workflow),
	"includes Build Signed APK step",
);
assert(
	/name:\s*Build Signed APK[\s\S]*?run:\s*\.\/gradlew\s+:app:assembleRelease/.test(
		workflow,
	),
	"runs module-scoped Gradle :app:assembleRelease task",
);
assert(
	/name:\s*Verify AAB Artifact & Checksum/.test(workflow),
	"includes Verify AAB Artifact & Checksum step",
);
assert(
	/name:\s*Verify AAB Artifact & Checksum[\s\S]*?sha256sum\s+"\$AAB_FILE"\s*>\s*"\$AAB_FILE\.sha256"/.test(
		workflow,
	),
	"generates SHA256 for app-release.aab",
);
assert(
	/name:\s*Verify APK Artifact & Checksum/.test(workflow),
	"includes Verify APK Artifact & Checksum step",
);
assert(
	/name:\s*Verify APK Artifact & Checksum[\s\S]*?sha256sum\s+"\$APK_FILE"\s*>\s*"\$APK_FILE\.sha256"/.test(
		workflow,
	),
	"generates SHA256 for app-release.apk",
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
	/name:\s*Create GitHub Release/.test(workflow),
	"includes Create GitHub Release step",
);
assert(
	/if:\s*github\.event_name\s*==\s*'push'\s*&&\s*startsWith\(github\.ref,\s*'refs\/tags\/'\)/.test(
		workflow,
	),
	"only creates releases for pushed tag refs",
);
assert(
	/gh release create "\$TAG_NAME"/.test(workflow),
	"creates GitHub release via gh cli",
);
assert(
	/name:\s*Version Gate Check/.test(workflow),
	"includes Version Gate Check step",
);
assert(
	workflow.includes(
		'if [[ "$TAG_NAME" =~ ^v([0-9]+\\.[0-9]+\\.[0-9]+)-rc\\.[0-9]+$ ]]; then',
	),
	"extracts base semver from rc tags for version gate",
);
assert(
	/TAG_BASE_VERSION="\$\{BASH_REMATCH\[1\]\}"/.test(workflow),
	"captures base semver with BASH_REMATCH",
);
assert(
	workflow.includes(
		'elif [[ "$TAG_NAME" =~ ^v([0-9]+\\.[0-9]+\\.[0-9]+)$ ]]; then',
	),
	"accepts stable tags in version gate",
);
assert(
	/if \[ "\$TAG_BASE_VERSION" != "\$PKG_VERSION" \]; then/.test(workflow),
	"compares package.json version against extracted base semver",
);
assert(
	/Unsupported tag format for version gate/.test(workflow),
	"fails fast on unsupported tag format in version gate",
);
assert(
	workflow.includes(
		'if [[ "$TAG_NAME" =~ ^v[0-9]+\\.[0-9]+\\.[0-9]+-rc\\.[0-9]+$ ]]; then',
	),
	"marks vX.Y.Z-rc.N tags as prerelease",
);
assert(
	workflow.includes(
		'elif [[ "$TAG_NAME" =~ ^v[0-9]+\\.[0-9]+\\.[0-9]+$ ]]; then',
	),
	"detects stable vX.Y.Z tags for non-prerelease releases",
);
assert(
	/--prerelease=\$PRERELEASE/.test(workflow),
	"passes prerelease flag from tag detection",
);
assert(
	/name:\s*Upload Release Assets/.test(workflow),
	"includes Upload Release Assets step",
);
assert(
	/name:\s*Upload Release Assets[\s\S]*?if:\s*github\.event_name\s*==\s*'push'\s*&&\s*startsWith\(github\.ref,\s*'refs\/tags\/'\)/.test(
		workflow,
	),
	"only uploads release assets for pushed tag refs",
);
assert(
	/gh release upload "\$TAG_NAME"/.test(workflow),
	"uploads assets to GitHub release via gh cli",
);
assert(
	/mobile\/rho-android\/android\/app\/build\/outputs\/bundle\/release\/app-release\.aab\.sha256/.test(
		workflow,
	),
	"uploads app-release.aab.sha256 to release",
);
assert(
	/mobile\/rho-android\/android\/app\/build\/outputs\/apk\/release\/app-release\.apk\.sha256/.test(
		workflow,
	),
	"uploads app-release.apk.sha256 to release",
);

console.log(`\n=== Results: ${PASS} passed, ${FAIL} failed ===\n`);
process.exit(FAIL > 0 ? 1 : 0);
