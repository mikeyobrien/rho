import fs from "node:fs";
import path from "node:path";
import app from "../web/server.ts";

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

function assertEq(actual: unknown, expected: unknown, label: string): void {
	const a = JSON.stringify(actual);
	const e = JSON.stringify(expected);
	if (a === e) {
		console.log(`  PASS: ${label}`);
		PASS++;
		return;
	}
	console.error(`  FAIL: ${label} (expected ${e}, got ${a})`);
	FAIL++;
}

console.log("\n=== Web Vendor Asset Tests ===\n");

console.log("-- vendor routes serve same-origin boot assets --");
{
	const cases: Array<[string, string]> = [
		["/vendor/alpine.js", "javascript"],
		["/vendor/marked.js", "javascript"],
		["/vendor/highlight.js", "javascript"],
		["/vendor/highlight-github-dark.css", "text/css"],
		["/vendor/highlight-github.css", "text/css"],
		["/vendor/highlight-typescript.js", "javascript"],
		["/vendor/highlight-python.js", "javascript"],
		["/vendor/highlight-rust.js", "javascript"],
		["/vendor/highlight-go.js", "javascript"],
		["/vendor/highlight-bash.js", "javascript"],
	];

	for (const [route, contentTypeNeedle] of cases) {
		const response = await app.fetch(new Request(`http://localhost${route}`));
		assertEq(response.status, 200, `${route} returns 200`);
		assert(
			(response.headers.get("Content-Type") || "").includes(contentTypeNeedle),
			`${route} content-type includes ${contentTypeNeedle}`,
		);
	}
}

console.log(
	"\n-- main web shell references local boot assets instead of third-party CDNs --",
);
{
	const htmlPath = path.resolve("web/public/index.html");
	const html = fs.readFileSync(htmlPath, "utf8");

	assert(
		html.includes('href="/vendor/highlight-github-dark.css"'),
		"index.html uses local highlight theme",
	);
	assert(
		html.includes('src="/vendor/marked.js"'),
		"index.html uses local marked runtime",
	);
	assert(
		html.includes('src="/vendor/highlight.js"'),
		"index.html uses local highlight runtime",
	);
	assert(
		html.includes('src="/vendor/alpine.js" defer'),
		"index.html uses local Alpine runtime",
	);

	assert(
		!html.includes("https://unpkg.com/htmx.org"),
		"index.html no longer pulls htmx from unpkg",
	);
	assert(
		!html.includes("https://cdn.jsdelivr.net/npm/marked/marked.min.js"),
		"index.html no longer pulls marked from jsDelivr",
	);
	assert(
		!html.includes(
			"https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js",
		),
		"index.html no longer pulls highlight.js runtime from cdnjs",
	);
	assert(
		!html.includes(
			"https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github-dark.min.css",
		),
		"index.html no longer pulls highlight theme from cdnjs",
	);
	assert(
		!html.includes("https://unpkg.com/alpinejs@3.13.5/dist/cdn.min.js"),
		"index.html no longer pulls Alpine from unpkg",
	);
}

console.log("\n-- review page also uses local Alpine/highlight assets --");
{
	const htmlPath = path.resolve("web/public/review/index.html");
	const html = fs.readFileSync(htmlPath, "utf8");

	assert(
		html.includes('href="/vendor/highlight-github-dark.css"'),
		"review/index.html uses local dark highlight theme",
	);
	assert(
		html.includes('href="/vendor/highlight-github.css"'),
		"review/index.html uses local light highlight theme",
	);
	assert(
		html.includes('src="/vendor/highlight.js"'),
		"review/index.html uses local highlight runtime",
	);
	assert(
		html.includes('src="/vendor/highlight-typescript.js"'),
		"review/index.html uses local TypeScript highlighter",
	);
	assert(
		html.includes('src="/vendor/highlight-python.js"'),
		"review/index.html uses local Python highlighter",
	);
	assert(
		html.includes('src="/vendor/highlight-rust.js"'),
		"review/index.html uses local Rust highlighter",
	);
	assert(
		html.includes('src="/vendor/highlight-go.js"'),
		"review/index.html uses local Go highlighter",
	);
	assert(
		html.includes('src="/vendor/highlight-bash.js"'),
		"review/index.html uses local Bash highlighter",
	);
	assert(
		html.includes('src="/vendor/alpine.js"'),
		"review/index.html uses local Alpine runtime",
	);
	assert(
		!html.includes(
			"https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/",
		),
		"review/index.html no longer pulls highlight assets from cdnjs",
	);
	assert(
		!html.includes(
			"https://cdn.jsdelivr.net/npm/alpinejs@3.x.x/dist/cdn.min.js",
		),
		"review/index.html no longer pulls Alpine from jsDelivr",
	);
}

console.log(`\n=== Results: ${PASS} passed, ${FAIL} failed ===\n`);
process.exit(FAIL > 0 ? 1 : 0);
