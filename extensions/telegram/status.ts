export interface TelegramStatusSnapshot {
  enabled: boolean;
  mode: "polling" | "webhook";
  leadershipText: string;
  pollLockPath: string;
  pollLockOwnerText: string;
  triggerPath: string;
  triggerPending: boolean;
  triggerRequesterPid: number | null;
  triggerRequestedAt: number | null;
  lastCheckRequestAt: number | null;
  lastCheckConsumeAt: number | null;
  lastCheckOutcome: "ok" | "error" | null;
  lastCheckRequesterPid: number | null;
  tokenEnv: string;
  lastUpdateId: number;
  lastPollAt: string | null;
  pollFailures: number;
  sendFailures: number;
  pendingInbound: number;
  pendingOutbound: number;
  allowedChatsText: string;
  allowedUsersText: string;
}

export interface TelegramUiStatusInput {
  mode: "polling" | "webhook";
  isLeader: boolean;
  ownerPid: number | null;
  lastUpdateId: number;
  pendingInbound: number;
  pendingOutbound: number;
  pollFailures: number;
  sendFailures: number;
  triggerPending: boolean;
}

function formatTsMs(ts: number | null): string {
  if (!ts) return "never";
  try {
    return new Date(ts).toISOString();
  } catch {
    return "invalid";
  }
}

export function renderTelegramUiStatus(input: TelegramUiStatusInput): string {
  const mode = input.mode === "webhook" ? "wh" : "poll";
  const role = input.isLeader ? "L" : input.ownerPid ? `F${input.ownerPid}` : "F";
  const trigger = input.triggerPending ? " tr!" : "";
  return `tg ${mode}${role}#${input.lastUpdateId} in${input.pendingInbound} out${input.pendingOutbound} pf${input.pollFailures} sf${input.sendFailures}${trigger}`;
}

export function renderTelegramStatusText(snapshot: TelegramStatusSnapshot): string {
  return [
    `Telegram: ${snapshot.enabled ? "enabled" : "disabled"} (${snapshot.mode})`,
    `Leadership: ${snapshot.leadershipText}`,
    `Poll lock: ${snapshot.pollLockPath}`,
    `Poll lock owner: ${snapshot.pollLockOwnerText}`,
    `Check trigger: ${snapshot.triggerPath}`,
    `Check trigger pending: ${snapshot.triggerPending ? "yes" : "no"}`,
    `Check trigger requester pid: ${snapshot.triggerRequesterPid ?? "none"}`,
    `Check trigger requested at: ${formatTsMs(snapshot.triggerRequestedAt)}`,
    `Last check request at: ${formatTsMs(snapshot.lastCheckRequestAt)}`,
    `Last check consume at: ${formatTsMs(snapshot.lastCheckConsumeAt)}`,
    `Last check outcome: ${snapshot.lastCheckOutcome ?? "unknown"}`,
    `Last check requester pid: ${snapshot.lastCheckRequesterPid ?? "none"}`,
    `Token env: ${snapshot.tokenEnv}`,
    `Last update id: ${snapshot.lastUpdateId}`,
    `Last poll: ${snapshot.lastPollAt ?? "never"}`,
    `Poll failures: ${snapshot.pollFailures}`,
    `Send failures: ${snapshot.sendFailures}`,
    `Pending inbound queue: ${snapshot.pendingInbound}`,
    `Pending outbound queue: ${snapshot.pendingOutbound}`,
    `Allowed chats: ${snapshot.allowedChatsText}`,
    `Allowed users: ${snapshot.allowedUsersText}`,
  ].join("\n");
}
