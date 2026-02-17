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

export type {
  BootstrapStatus,
  ValidateResult as BootstrapValidateResult,
  BootstrapMetaShape,
  ManagedMetadataShape,
  ManagedKeyInput,
} from "./brain-bootstrap-schema.ts";
export {
  BOOTSTRAP_STATUS_NOT_STARTED,
  BOOTSTRAP_STATUS_PARTIAL,
  BOOTSTRAP_STATUS_COMPLETED,
  AGENTIC_BOOTSTRAP_ID,
  BOOTSTRAP_SOURCE_PREFIX,
  DEFAULT_BOOTSTRAP_SOURCE,
  BOOTSTRAP_META_KEYS,
  isKnownBootstrapRevision,
  isIsoTimestamp,
  validateBootstrapMeta,
  validateManagedMetadata,
  buildManagedKey,
} from "./brain-bootstrap-schema.ts";

export type { BrainLikeEntry, BootstrapState } from "./brain-bootstrap-state.ts";
export { getBootstrapState, markBootstrapCompleted } from "./brain-bootstrap-state.ts";

export type { MigrationPaths, MigrationStatus, MigrationStats } from "./brain-migration.ts";
export { detectMigration, detectMigrationWithPaths, runMigration, runMigrationWithPaths } from "./brain-migration.ts";
