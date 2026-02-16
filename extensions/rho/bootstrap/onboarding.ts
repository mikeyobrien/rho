/**
 * extensions/rho/bootstrap/onboarding.ts
 *
 * Brain-native onboarding validation helpers.
 *
 * BT-02 scope: pure validation + completion gating.
 */

export const RESPONSE_STYLES = ["concise", "balanced", "detailed"] as const;
export type ResponseStyle = (typeof RESPONSE_STYLES)[number];

export const EXTERNAL_ACTION_POLICIES = ["always-ask", "ask-risky-only"] as const;
export type ExternalActionPolicy = (typeof EXTERNAL_ACTION_POLICIES)[number];

export const PROACTIVE_CADENCE_PRESETS = ["off", "light", "standard"] as const;
export type ProactiveCadencePreset = (typeof PROACTIVE_CADENCE_PRESETS)[number];

export type OnboardingState =
  | "idle"
  | "collecting"
  | "confirming"
  | "applied"
  | "aborted"
  | "failed";

export interface OnboardingAnswers {
  name: string;
  timezone: string;
  style: ResponseStyle;
  externalActionPolicy: ExternalActionPolicy;
  codingTaskFirst?: boolean;
  quietHours?: string;
  proactiveCadence?: ProactiveCadencePreset;
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isValidIanaTimezone(value: string): boolean {
  try {
    // Throws RangeError on invalid timezone in modern Node runtimes.
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

function isQuietHours(value: string): boolean {
  // Accept HH:mm-HH:mm (local, overnight ranges allowed by caller semantics).
  return /^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

function isOneOf<T extends readonly string[]>(value: string, allowed: T): value is T[number] {
  return allowed.includes(value as T[number]);
}

export function validateOnboardingAnswers(answers: Record<string, unknown>): ValidationResult {
  const errors: string[] = [];

  if (!isObject(answers)) {
    return { ok: false, errors: ["answers must be an object"] };
  }

  const name = typeof answers.name === "string" ? answers.name.trim() : "";
  const timezone = typeof answers.timezone === "string" ? answers.timezone.trim() : "";
  const style = typeof answers.style === "string" ? answers.style.trim() : "";
  const externalPolicy =
    typeof answers.externalActionPolicy === "string" ? answers.externalActionPolicy.trim() : "";

  if (!name) {
    errors.push("name is required");
  } else if (name.length > 80) {
    errors.push("name must be <= 80 characters");
  }

  if (!timezone) {
    errors.push("timezone is required");
  } else if (!isValidIanaTimezone(timezone)) {
    errors.push(`invalid timezone: ${timezone}`);
  }

  if (!style) {
    errors.push("style is required");
  } else if (!isOneOf(style, RESPONSE_STYLES)) {
    errors.push(`style must be one of: ${RESPONSE_STYLES.join(", ")}`);
  }

  if (!externalPolicy) {
    errors.push("externalActionPolicy is required");
  } else if (!isOneOf(externalPolicy, EXTERNAL_ACTION_POLICIES)) {
    errors.push(`externalActionPolicy must be one of: ${EXTERNAL_ACTION_POLICIES.join(", ")}`);
  }

  if (
    answers.codingTaskFirst !== undefined &&
    typeof answers.codingTaskFirst !== "boolean"
  ) {
    errors.push("codingTaskFirst must be boolean when provided");
  }

  if (answers.quietHours !== undefined) {
    if (typeof answers.quietHours !== "string" || !isQuietHours(answers.quietHours.trim())) {
      errors.push("quietHours must match HH:mm-HH:mm when provided");
    }
  }

  if (answers.proactiveCadence !== undefined) {
    if (
      typeof answers.proactiveCadence !== "string" ||
      !isOneOf(answers.proactiveCadence, PROACTIVE_CADENCE_PRESETS)
    ) {
      errors.push(`proactiveCadence must be one of: ${PROACTIVE_CADENCE_PRESETS.join(", ")}`);
    }
  }

  return { ok: errors.length === 0, errors };
}

export function shouldMarkBootstrapComplete(state: string): boolean {
  const normalized = state.trim().toLowerCase();
  return normalized === "applied" || normalized === "complete" || normalized === "completed";
}
