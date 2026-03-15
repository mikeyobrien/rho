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

console.log("\n=== Nix Android Dev Shell Checks ===\n");

const flake = fs.readFileSync("flake.nix", "utf8");
const docs = fs.readFileSync("docs/nix-android-dev-shell.md", "utf8");

assert(
	/platformVersions\s*=\s*\[\s*androidPlatformVersion\s*\]/.test(flake),
	"flake pins Android platform via shared variable",
);
assert(
	/androidPlatformVersion\s*=\s*"35"/.test(flake),
	"flake targets Android platform 35",
);
assert(
	/androidBuildToolsVersion\s*=\s*"35\.0\.0"/.test(flake),
	"flake targets build-tools 35.0.0",
);
assert(
	/includeEmulator\s*=\s*emulatorSupported/.test(flake),
	"flake enables emulator on supported hosts",
);
assert(
	/includeSystemImages\s*=\s*emulatorSupported/.test(flake),
	"flake enables system images on supported hosts",
);
assert(
	/systemImageTypes\s*=\s*\[\s*androidSystemImageType\s*\]/.test(flake),
	"flake requests a specific system image type",
);
assert(
	/androidSystemImageType\s*=\s*"google_apis"/.test(flake),
	"flake uses Google APIs system image",
);
assert(
	/androidEmulatorAbi\s*=\s*"x86_64"/.test(flake),
	"flake uses x86_64 emulator ABI on x86_64 hosts",
);
assert(/ANDROID_AVD_HOME/.test(flake), "flake exports ANDROID_AVD_HOME");
assert(
	/\$ANDROID_SDK_ROOT\/emulator/.test(flake),
	"flake adds emulator binary dir to PATH",
);
assert(
	/steam-run/.test(flake),
	"flake includes steam-run for emulator compatibility",
);
assert(/avdmanager create avd/.test(docs), "docs explain AVD creation");
assert(
	/steam-run emulator -avd rho-api35/.test(docs),
	"docs explain steam-run emulator launch",
);
assert(/\/dev\/kvm/.test(docs), "docs mention /dev/kvm requirement");
assert(
	/non-`x86_64-linux` hosts.*emulator support is intentionally disabled/i.test(
		docs,
	),
	"docs explain non-x86_64 emulator limitation",
);

console.log(`\n=== Results: ${PASS} passed, ${FAIL} failed ===\n`);
process.exit(FAIL > 0 ? 1 : 0);
