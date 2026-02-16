/**
 * extensions/lib/brain-bootstrap-schema.ts
 *
 * Schema + helpers for brain-native bootstrap metadata.
 *
 * This module is intentionally side-effect free and does not write to disk.
 */

export const BOOTSTRAP_STATUS_NOT_STARTED = "not_started" as const;
export const BOOTSTRAP_STATUS_PARTIAL = "partial" as const;
export const BOOTSTRAP_STATUS_COMPLETED = "completed" as const;

export type BootstrapStatus =
  | typeof BOOTSTRAP_STATUS_NOT_STARTED
  | typeof BOOTSTRAP_STATUS_PARTIAL
  | typeof BOOTSTRAP_STATUS_COMPLETED;

export const PERSONAL_ASSISTANT_PROFILE_ID = "personal-assistant" as const;
export const PROFILE_SOURCE_PREFIX = "profile:" as const;
export const DEFAULT_PROFILE_SOURCE = `${PROFILE_SOURCE_PREFIX}${PERSONAL_ASSISTANT_PROFILE_ID}` as const;

export const BOOTSTRAP_META_KEYS = {
  completed: "bootstrap.completed",
  version: "bootstrap.version",
  completedAt: "bootstrap.completedAt",
} as const;

export interface ValidateResult {
  ok: boolean;
  errors: string[];
}

export interface BootstrapMetaShape {
  completed?: unknown;
  version?: unknown;
  completedAt?: unknown;
}

export interface ManagedMetadataShape {
  managed?: unknown;
  source?: unknown;
  sourceVersion?: unknown;
  managedKey?: unknown;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function isKnownProfileVersion(version: string): boolean {
  return /^pa-v\d+$/.test(version.trim());
}

export function isIsoTimestamp(value: string): boolean {
  const s = value.trim();
  if (!s) return false;

  // Keep this strict and stable for machine-generated timestamps.
  const isoLike = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
  if (!isoLike.test(s)) return false;

  const parsed = Date.parse(s);
  return Number.isFinite(parsed);
}

export function validateBootstrapMeta(input: unknown): ValidateResult {
  const errors: string[] = [];

  if (!isObject(input)) {
    return { ok: false, errors: ["bootstrap meta must be an object"] };
  }

  const { completed, version, completedAt } = input as BootstrapMetaShape;

  if (completed !== undefined && typeof completed !== "boolean") {
    errors.push("completed must be boolean when provided");
  }

  if (version !== undefined) {
    if (typeof version !== "string" || !version.trim()) {
      errors.push("version must be a non-empty string when provided");
    } else if (!isKnownProfileVersion(version)) {
      errors.push(`version must match pa-vN format (got \"${version}\")`);
    }
  }

  if (completedAt !== undefined) {
    if (typeof completedAt !== "string" || !isIsoTimestamp(completedAt)) {
      errors.push("completedAt must be an ISO-8601 UTC timestamp");
    }
  }

  if (completed === true) {
    if (typeof version !== "string" || !version.trim()) {
      errors.push("version is required when completed is true");
    }
    if (typeof completedAt !== "string" || !isIsoTimestamp(completedAt)) {
      errors.push("completedAt is required (ISO-8601 UTC) when completed is true");
    }
  }

  return { ok: errors.length === 0, errors };
}

export function validateManagedMetadata(input: unknown): ValidateResult {
  const errors: string[] = [];

  if (!isObject(input)) {
    return { ok: false, errors: ["managed metadata must be an object"] };
  }

  const { managed, source, sourceVersion, managedKey } = input as ManagedMetadataShape;

  if (managed !== undefined && typeof managed !== "boolean") {
    errors.push("managed must be boolean when provided");
  }

  if (managed === true) {
    if (typeof source !== "string" || !source.trim()) {
      errors.push("source is required when managed is true");
    }
    if (typeof sourceVersion !== "string" || !sourceVersion.trim()) {
      errors.push("sourceVersion is required when managed is true");
    } else if (!isKnownProfileVersion(sourceVersion)) {
      errors.push(`sourceVersion must match pa-vN format (got \"${sourceVersion}\")`);
    }
    if (typeof managedKey !== "string" || !managedKey.trim()) {
      errors.push("managedKey is required when managed is true");
    }
  }

  return { ok: errors.length === 0, errors };
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

export interface ManagedKeyInput {
  type: string;
  category?: string;
  key?: string;
  text?: string;
}

/**
 * Build deterministic managed keys from semantic entry identity.
 *
 * Priority: key > category+text > text
 */
export function buildManagedKey(input: ManagedKeyInput): string {
  const type = slugify(input.type || "entry") || "entry";

  if (input.key && input.key.trim()) {
    return `${type}:${input.key.trim()}`;
  }

  const category = input.category?.trim();
  const text = input.text?.trim();

  if (category && text) {
    return `${type}:${slugify(category)}:${slugify(text)}`;
  }

  if (text) {
    return `${type}:${slugify(text)}`;
  }

  return `${type}:generated`;
}
