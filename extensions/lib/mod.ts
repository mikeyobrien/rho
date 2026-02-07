/**
 * extensions/lib/mod.ts
 *
 * Barrel exports for shared extension libraries.
 *
 * Important: do NOT name this file index.ts, otherwise pi will treat
 * extensions/lib/ as an extension entry point during discovery.
 */

export type { Frontmatter } from "./vault-lib.ts";
export { parseFrontmatter, stripFrontmatter, extractWikilinks, extractTitle } from "./vault-lib.ts";

export type {
  VaultNoteType,
  VaultSearchMode,
  VaultSearchParams,
  VaultSearchResult,
} from "./vault-search-lib.ts";

export { VaultSearch, sanitizeFtsQuery } from "./vault-search-lib.ts";
