/**
 * extensions/rho/bootstrap/mapping.ts
 *
 * Map validated onboarding answers into brain primitive entry drafts.
 *
 * BT-02 scope: deterministic pure mapping for user/preference/context.
 */

import type { OnboardingAnswers } from "./onboarding.ts";

export interface EntryDraft {
  type: string;
  key?: string;
  value?: unknown;
  category?: string;
  text?: string;
  project?: string;
  path?: string;
  content?: string;
}

export interface MappedEntries {
  user: EntryDraft[];
  preference: EntryDraft[];
  context: EntryDraft[];
  behavior: EntryDraft[];
  reminder: EntryDraft[];
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asBoolean(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function asCadence(value: unknown): "off" | "light" | "standard" {
  const s = asString(value);
  if (s === "off" || s === "light" || s === "standard") return s;
  return "off";
}

export function mapOnboardingAnswersToEntries(
  answers: Record<string, unknown>,
): MappedEntries {
  const name = asString(answers.name);
  const timezone = asString(answers.timezone);
  const style = asString(answers.style) || "balanced";
  const externalActionPolicy = asString(answers.externalActionPolicy) || "ask-risky-only";
  const codingTaskFirst = asBoolean(answers.codingTaskFirst, false);
  const quietHours = asString(answers.quietHours);
  const proactiveCadence = asCadence(answers.proactiveCadence);

  const user: EntryDraft[] = [
    {
      type: "user",
      key: "name",
      value: name,
      text: `name: ${name}`,
    },
    {
      type: "user",
      key: "timezone",
      value: timezone,
      text: `timezone: ${timezone}`,
    },
  ];

  const preference: EntryDraft[] = [
    {
      type: "preference",
      category: "communication",
      text: `response style: ${style}`,
      key: "communication.style",
      value: style,
    },
    {
      type: "preference",
      category: "risk",
      text: `external actions policy: ${externalActionPolicy}`,
      key: "risk.externalActions",
      value: externalActionPolicy,
    },
  ];

  if (codingTaskFirst) {
    preference.push({
      type: "preference",
      category: "coding",
      text: "coding policy: propose code tasks before implementation",
      key: "coding.taskFirst",
      value: true,
    });
  }

  const context: EntryDraft[] = [
    {
      type: "context",
      project: "rho",
      path: "bootstrap/workflow.approvalGate",
      content: codingTaskFirst ? "propose-approve-implement" : "direct-implementation-allowed",
      key: "workflow.approvalGate",
      value: codingTaskFirst ? "propose-approve-implement" : "direct-implementation-allowed",
      text: codingTaskFirst
        ? "workflow: propose -> approve -> implement"
        : "workflow: direct implementation allowed",
    },
  ];

  if (quietHours) {
    context.push({
      type: "context",
      project: "rho",
      path: "bootstrap/quietHours",
      content: quietHours,
      key: "quietHours",
      value: quietHours,
      text: `quiet hours: ${quietHours}`,
    });
  }

  context.push({
    type: "context",
    project: "rho",
    path: "bootstrap/proactiveCadence",
    content: proactiveCadence,
    key: "proactiveCadence",
    value: proactiveCadence,
    text: `proactive cadence: ${proactiveCadence}`,
  });

  const behavior: EntryDraft[] = [
    {
      type: "behavior",
      category: "do",
      text: "Be direct and useful; avoid filler.",
    },
    {
      type: "behavior",
      category: "do",
      text:
        externalActionPolicy === "always-ask"
          ? "Ask before external actions."
          : "Ask before risky external actions.",
    },
  ];

  const reminder: EntryDraft[] = [];
  if (proactiveCadence === "light") {
    reminder.push({
      type: "reminder",
      text: "Review today and propose top priorities.",
      value: { kind: "daily", at: "09:00" },
      key: "cadence",
    });
  } else if (proactiveCadence === "standard") {
    reminder.push(
      {
        type: "reminder",
        text: "Morning planning check.",
        value: { kind: "daily", at: "09:00" },
        key: "cadence",
      },
      {
        type: "reminder",
        text: "Afternoon progress review.",
        value: { kind: "daily", at: "16:00" },
        key: "cadence",
      },
    );
  }

  return { user, preference, context, behavior, reminder };
}

// Keep type import used and surfaced for future call sites.
export type { OnboardingAnswers };
