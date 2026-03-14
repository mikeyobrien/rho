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

function readJson(path: string): Record<string, unknown> {
	return JSON.parse(fs.readFileSync(path, "utf8")) as Record<string, unknown>;
}

console.log("\n=== Android Store Readiness Checks ===\n");

const variablesGradle = fs.readFileSync(
	"mobile/rho-android/android/variables.gradle",
	"utf8",
);
const appBuildGradle = fs.readFileSync(
	"mobile/rho-android/android/app/build.gradle",
	"utf8",
);
const workflow = fs.readFileSync(
	".github/workflows/android-release.yml",
	"utf8",
);
const rootPkg = readJson("package.json");
const mobilePkg = readJson("mobile/rho-android/package.json");

assert(
	/compileSdkVersion\s*=\s*35/.test(variablesGradle),
	"compile SDK bumped to 35",
);
assert(
	/targetSdkVersion\s*=\s*35/.test(variablesGradle),
	"target SDK bumped to 35",
);
assert(
	/JsonSlurper/.test(appBuildGradle),
	"app build.gradle parses package metadata",
);
assert(
	/semverToVersionCode/.test(appBuildGradle),
	"app build.gradle derives Android versionCode from semver",
);
assert(
	/versionName\s+appVersionName/.test(appBuildGradle),
	"app build.gradle uses computed versionName",
);
assert(
	/versionCode\s+appVersionCode/.test(appBuildGradle),
	"app build.gradle uses computed versionCode",
);
assert(
	mobilePkg.version === rootPkg.version,
	"mobile package version matches root package version",
);
assert(
	/MOBILE_PKG_VERSION=/.test(workflow),
	"release workflow validates mobile package version",
);
assert(
	fs.existsSync("mobile/rho-android/fastlane/metadata/android/en-US/title.txt"),
	"fastlane title metadata exists",
);
assert(
	fs.existsSync(
		"mobile/rho-android/fastlane/metadata/android/en-US/short_description.txt",
	),
	"fastlane short description metadata exists",
);
assert(
	fs.existsSync(
		"mobile/rho-android/fastlane/metadata/android/en-US/full_description.txt",
	),
	"fastlane full description metadata exists",
);
assert(
	fs.existsSync(
		"mobile/rho-android/fastlane/metadata/android/contact_email.txt",
	),
	"fastlane contact email metadata exists",
);
assert(
	fs.existsSync(
		"mobile/rho-android/fastlane/metadata/android/contact_website.txt",
	),
	"fastlane contact website metadata exists",
);
assert(
	fs.existsSync(
		"mobile/rho-android/fastlane/metadata/android/en-US/changelogs/default.txt",
	),
	"fastlane default release notes metadata exists",
);
assert(
	fs.existsSync("mobile/rho-android/fastlane/metadata/android/privacy_url.txt"),
	"fastlane privacy policy metadata exists",
);
assert(
	fs.existsSync("docs/rho-android-privacy-policy.md"),
	"android privacy policy doc exists",
);
assert(
	fs.existsSync("docs/android-store-submission.md"),
	"android store submission doc exists",
);

console.log(`\n=== Results: ${PASS} passed, ${FAIL} failed ===\n`);
process.exit(FAIL > 0 ? 1 : 0);
