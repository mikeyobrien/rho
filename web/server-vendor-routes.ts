import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { app } from "./server-core.ts";

const require = createRequire(import.meta.url);

function packageDir(specifier: string): string {
	return path.dirname(require.resolve(`${specifier}/package.json`));
}

const alpinePath = path.join(packageDir("alpinejs"), "dist", "cdn.min.js");
const markedPath = path.join(packageDir("marked"), "lib", "marked.umd.js");
const highlightPackageDir = packageDir("@highlightjs/cdn-assets");
const highlightJsPath = path.join(highlightPackageDir, "highlight.min.js");
const highlightGithubDarkCssPath = path.join(
	highlightPackageDir,
	"styles",
	"github-dark.min.css",
);
const highlightGithubCssPath = path.join(
	highlightPackageDir,
	"styles",
	"github.min.css",
);
const highlightTypescriptPath = path.join(
	highlightPackageDir,
	"languages",
	"typescript.min.js",
);
const highlightPythonPath = path.join(
	highlightPackageDir,
	"languages",
	"python.min.js",
);
const highlightRustPath = path.join(
	highlightPackageDir,
	"languages",
	"rust.min.js",
);
const highlightGoPath = path.join(
	highlightPackageDir,
	"languages",
	"go.min.js",
);
const highlightBashPath = path.join(
	highlightPackageDir,
	"languages",
	"bash.min.js",
);

async function serveVendorAsset(
	filePath: string,
	contentType: string,
): Promise<Response> {
	const body = await readFile(filePath);
	return new Response(body, {
		headers: {
			"Content-Type": contentType,
			"Cache-Control": "no-cache",
		},
	});
}

function registerVendorAsset(
	routePath: string,
	filePath: string,
	contentType: string,
): void {
	app.get(routePath, async (c) => {
		try {
			return await serveVendorAsset(filePath, contentType);
		} catch (error) {
			return c.json(
				{
					error:
						(error as Error).message ??
						`Failed to load vendor asset ${path.basename(filePath)}`,
				},
				500,
			);
		}
	});
}

registerVendorAsset(
	"/vendor/alpine.js",
	alpinePath,
	"text/javascript; charset=utf-8",
);
registerVendorAsset(
	"/vendor/marked.js",
	markedPath,
	"text/javascript; charset=utf-8",
);
registerVendorAsset(
	"/vendor/highlight.js",
	highlightJsPath,
	"text/javascript; charset=utf-8",
);
registerVendorAsset(
	"/vendor/highlight-github-dark.css",
	highlightGithubDarkCssPath,
	"text/css; charset=utf-8",
);
registerVendorAsset(
	"/vendor/highlight-github.css",
	highlightGithubCssPath,
	"text/css; charset=utf-8",
);
registerVendorAsset(
	"/vendor/highlight-typescript.js",
	highlightTypescriptPath,
	"text/javascript; charset=utf-8",
);
registerVendorAsset(
	"/vendor/highlight-python.js",
	highlightPythonPath,
	"text/javascript; charset=utf-8",
);
registerVendorAsset(
	"/vendor/highlight-rust.js",
	highlightRustPath,
	"text/javascript; charset=utf-8",
);
registerVendorAsset(
	"/vendor/highlight-go.js",
	highlightGoPath,
	"text/javascript; charset=utf-8",
);
registerVendorAsset(
	"/vendor/highlight-bash.js",
	highlightBashPath,
	"text/javascript; charset=utf-8",
);
