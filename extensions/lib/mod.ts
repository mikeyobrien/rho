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

export type { LockPayload, FileLockOpts } from "./file-lock.ts";
export { withFileLock, isPidRunning } from "./file-lock.ts";

export type {
  BrainEntry,
  BehaviorEntry,
  IdentityEntry,
  UserEntry,
  LearningEntry,
  PreferenceEntry,
  ContextEntry,
  TaskEntry,
  ReminderEntry,
  TombstoneEntry,
  MetaEntry,
  MaterializedBrain,
} from "./brain-store.ts";
export {
  SCHEMA_REGISTRY,
  BRAIN_DIR,
  BRAIN_PATH,
  validateEntry,
  deterministicId,
  readBrain,
  foldBrain,
  appendBrainEntry,
  appendBrainEntryWithDedup,
  buildBrainPrompt,
} from "./brain-store.ts";

export type { BrainActionResult } from "./brain-tool.ts";
export { handleBrainAction } from "./brain-tool.ts";
