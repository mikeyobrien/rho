/**
 * extensions/rho/bootstrap/profile-pack.ts
 *
 * Built-in bootstrap profile packs.
 */

import type { MergeEntry } from "./merge-policy.ts";

export interface ProfilePack {
  profileId: string;
  version: string;
  entries: MergeEntry[];
}

const PERSONAL_ASSISTANT_ID = "personal-assistant";

const PERSONAL_ASSISTANT_PACKS: ProfilePack[] = [
  {
    profileId: PERSONAL_ASSISTANT_ID,
    version: "pa-v1",
    entries: [
      {
        type: "preference",
        category: "communication",
        key: "communication.style",
        value: "balanced",
        text: "response style: balanced",
        managedKey: "preference:communication.style",
      },
      {
        type: "behavior",
        category: "do",
        text: "Ask before risky external actions",
        managedKey: "behavior:do:ask-before-risky-external-actions",
      },
      {
        type: "context",
        project: "rho",
        path: "bootstrap/workflow.approvalGate",
        key: "workflow.approvalGate",
        value: "propose-approve-implement",
        content: "propose-approve-implement",
        text: "workflow: propose -> approve -> implement",
        managedKey: "context:workflow.approvalGate",
      },
    ],
  },
  {
    profileId: PERSONAL_ASSISTANT_ID,
    version: "pa-v2",
    entries: [
      {
        type: "preference",
        category: "communication",
        key: "communication.style",
        value: "balanced",
        text: "response style: balanced",
        managedKey: "preference:communication.style",
      },
      {
        type: "behavior",
        category: "do",
        text: "Ask before risky external actions and confirm irreversible operations",
        managedKey: "behavior:do:ask-before-risky-external-actions",
      },
      {
        type: "context",
        project: "rho",
        path: "bootstrap/workflow.approvalGate",
        key: "workflow.approvalGate",
        value: "propose-approve-implement",
        content: "propose-approve-implement",
        text: "workflow: propose -> approve -> implement",
        managedKey: "context:workflow.approvalGate",
      },
      {
        type: "context",
        project: "rho",
        path: "bootstrap/proactiveCadence",
        key: "proactiveCadence",
        value: "standard",
        content: "standard",
        text: "proactive cadence: standard",
        managedKey: "context:proactiveCadence",
      },
    ],
  },
];

function parseVersionNumber(version: string): number {
  const m = /^pa-v(\d+)$/.exec(version.trim());
  if (!m) return -1;
  return Number.parseInt(m[1], 10);
}

export function listProfileVersions(profileId: string): string[] {
  if (profileId !== PERSONAL_ASSISTANT_ID) return [];

  return PERSONAL_ASSISTANT_PACKS
    .map((p) => p.version)
    .sort((a, b) => parseVersionNumber(a) - parseVersionNumber(b));
}

export function getLatestProfileVersion(profileId: string): string | null {
  const versions = listProfileVersions(profileId);
  if (versions.length === 0) return null;
  return versions[versions.length - 1];
}

export function getProfilePack(profileId: string, version: string): ProfilePack | null {
  if (profileId !== PERSONAL_ASSISTANT_ID) return null;
  const found = PERSONAL_ASSISTANT_PACKS.find((p) => p.version === version);
  if (!found) return null;

  // Return a deep-ish copy so callers can mutate safely.
  return {
    profileId: found.profileId,
    version: found.version,
    entries: found.entries.map((e) => ({ ...e })),
  };
}
