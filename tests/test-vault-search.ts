/**
 * Tests for vault-search-lib.ts
 * Run: npx tsx tests/test-vault-search.ts
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawnSync } from "node:child_process";

import { VaultSearch } from "../extensions/lib/mod.ts";

let PASS = 0;
let FAIL = 0;

function assert(condition: boolean, label: string): void {
  if (condition) {
    console.log(`  PASS: ${label}`);
    PASS++;
  } else {
    console.error(`  FAIL: ${label}`);
    FAIL++;
  }
}

function writeFile(rel: string, content: string, root: string) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

async function main() {
  const TEST_VAULT = path.join(os.tmpdir(), `vault-search-test-${Date.now()}`);
  fs.mkdirSync(TEST_VAULT, { recursive: true });

  try {
    writeFile(
      "concepts/alpha.md",
      `---\n` +
        `type: concept\n` +
        `tags: [foo, bar]\n` +
        `---\n\n` +
        `# Alpha Note\n\n` +
        `Hello world from Alpha. See [[beta]].\n`,
      TEST_VAULT
    );

    writeFile(
      "patterns/beta.md",
      `---\n` +
        `type: pattern\n` +
        `tags: [bar]\n` +
        `---\n\n` +
        `# Beta Note\n\n` +
        `This mentions foobar and world again.\n`,
      TEST_VAULT
    );

    const searcher = new VaultSearch(TEST_VAULT);

    const rg = spawnSync("rg", ["--version"], { encoding: "utf-8" });
    const hasRg = rg.status === 0;
    assert(hasRg, "ripgrep (rg) is available for grep search");

    if (hasRg) {
      const res = await searcher.search({ query: "hello", mode: "grep" });
      assert(res.mode === "grep", "mode=grep uses grep");
      assert(res.results.length >= 1, "grep finds a match");
      assert(res.results[0].path.includes("alpha.md"), "grep returns matching note path");
    }

    const hasSqlite = await searcher.sqliteAvailable();
    if (!hasSqlite) {
      console.log("  (sqlite not available, skipping FTS tests)");
    } else {
      const res = await searcher.search({ query: "world", mode: "fts" });
      assert(res.mode === "fts", "mode=fts uses fts");
      assert(res.results.length >= 1, "fts finds a match");

      const tagRes = await searcher.search({ query: "world", mode: "fts", tags: ["foo", "bar"] });
      assert(tagRes.results.length === 1, "tag filter (ALL tags) narrows results");
      assert(tagRes.results[0].path.includes("alpha.md"), "tag filtered result is alpha.md");

      const reindexed = await searcher.reindex();
      assert(reindexed >= 2, "/vault-reindex equivalent rebuilds index");
    }

  } finally {
    try { fs.rmSync(TEST_VAULT, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  console.log(`\nPASS: ${PASS}, FAIL: ${FAIL}`);
  process.exitCode = FAIL === 0 ? 0 : 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
