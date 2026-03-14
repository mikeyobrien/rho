import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("Android string resources", () => {
	it("sets app display strings to rho", () => {
		const stringsPath = join(
			__dirname,
			"..",
			"android",
			"app",
			"src",
			"main",
			"res",
			"values",
			"strings.xml",
		);
		const xml = readFileSync(stringsPath, "utf8");

		expect(xml).toContain('<string name="app_name">rho</string>');
		expect(xml).toContain('<string name="title_activity_main">rho</string>');
	});
});
