import type { RunnerDatabase } from "../database.ts";
import { getIssue } from "./issues.ts";
import { type PiIssueCompletionWatch } from "./pi.ts";
import { normalizeTimestamp, type AutomationAudit, type AutomationID } from "../../domain/automation/contracts.ts";
import type { ImTargetV1 } from "../../integrations/im/imChannelContracts.ts";
import { cleanString, nonNegativeInteger } from "../../util/values.ts";

export type AutomationWatchStatus = "watching" | "satisfied" | "notified" | "expired" | "cancelled" | "failed";

export type AutomationWatchOutcome = "" | "completion" | "failure" | "cancelled" | "thread_event" | "timeout";

export type AutomationWatchCondition =
  | { match: "all" | "any"; metadata?: Record<string, unknown>; statuses: string[]; type: "issue_status" }
  | { event_types: string[]; metadata?: Record<string, unknown>; type: "external_thread_event" };

export type AutomationWatchSubject =
  | { issue_ids: number[]; kind: "issues" }
  | { kind: "external_thread"; provider: string; thread_id: string };

export type AutomationWatchNotificationTarget = Pick<ImTargetV1, "connector_id" | "conversation_id"> & {
  reply_to_message_id: string;
  thread_id: string;
};

type LegacyAutomationWatchNotificationTarget = {
  channel?: unknown;
  chat_id?: unknown;
  message_id?: unknown;
};

export type AutomationWatch = {
  automation_id: AutomationID;
  condition: AutomationWatchCondition;
  condition_json: string;
  created_at: string;
  dedupe_key: string;
  error: string;
  expires_at: string;
  last_external_event_id: number;
  legacy_watch_id: string;
  matched_ref: string;
  migration_mode: "native" | "legacy_shadow";
  notification_target: AutomationWatchNotificationTarget;
  notification_target_json: string;
  notified_at: string;
  outcome: AutomationWatchOutcome;
  satisfied_at: string;
  status: AutomationWatchStatus;
  subject: AutomationWatchSubject;
  subject_json: string;
  updated_at: string;
};

export type CreateAutomationWatchInput = {
  allow_empty_notification_target?: boolean;
  condition: AutomationWatchCondition;
  dedupe_key: string;
  expires_at?: string;
  id?: AutomationID;
  name: string;
  notification_target: AutomationWatchNotificationTarget;
  project_id: string;
  subject: AutomationWatchSubject;
};

export type LegacyWatchMigrationResult = {
  created: number;
  refreshed: number;
  scanned: number;
  unchanged: number;
};

export type Row = Record<string, unknown>;

type StoredWatch = Omit<AutomationWatch, "condition" | "notification_target" | "subject">;

export type DesiredShadow = {
  automationID: AutomationID;
  condition: AutomationWatchCondition;
  dedupeKey: string;
  expiresAt: string;
  legacy: PiIssueCompletionWatch;
  notificationTarget: AutomationWatchNotificationTarget;
  outcome: AutomationWatchOutcome;
  status: AutomationWatchStatus;
  subject: AutomationWatchSubject;
};

export const TABLE = "automation_watches";

export const COLUMNS = `automation_id, migration_mode, legacy_watch_id, condition_json,
  subject_json, notification_target_json, dedupe_key, expires_at, status,
  outcome, matched_ref, last_external_event_id, satisfied_at, notified_at,
  error, created_at, updated_at`;

export const TERMINAL_STATUSES = new Set(["done", "failed", "cancelled"]);

export function mapWatch(row: Row): AutomationWatch {
  const stored: StoredWatch = {
    automation_id: cleanString(row.automation_id) as AutomationID,
    condition_json: cleanString(row.condition_json) || "{}",
    created_at: cleanString(row.created_at),
    dedupe_key: cleanString(row.dedupe_key),
    error: cleanString(row.error),
    expires_at: cleanString(row.expires_at),
    last_external_event_id: nonNegativeInteger(row.last_external_event_id),
    legacy_watch_id: cleanString(row.legacy_watch_id),
    matched_ref: cleanString(row.matched_ref),
    migration_mode: row.migration_mode === "legacy_shadow" ? "legacy_shadow" : "native",
    notification_target_json: cleanString(row.notification_target_json) || "{}",
    notified_at: cleanString(row.notified_at),
    outcome: watchOutcome(row.outcome),
    satisfied_at: cleanString(row.satisfied_at),
    status: watchStatus(row.status),
    subject_json: cleanString(row.subject_json) || "{}",
    updated_at: cleanString(row.updated_at)
  };
  return {
    ...stored,
    condition: parseObject(stored.condition_json) as AutomationWatchCondition,
    notification_target: normalizeNotificationTarget(parseObject(stored.notification_target_json), false),
    subject: parseObject(stored.subject_json) as AutomationWatchSubject
  };
}

export function normalizeCondition(value: AutomationWatchCondition): AutomationWatchCondition {
  if (value?.type === "issue_status") {
    const statuses = [...new Set((value.statuses ?? []).map(cleanString).filter((item) => TERMINAL_STATUSES.has(item)))].sort();
    if (statuses.length === 0) throw new Error("issue watch requires terminal statuses");
    if (!['all', 'any'].includes(value.match)) throw new Error("issue watch match must be all or any");
    return { match: value.match, ...(value.metadata ? { metadata: parseObject(value.metadata) } : {}), statuses, type: "issue_status" };
  }
  if (value?.type === "external_thread_event") {
    const eventTypes = [...new Set((value.event_types ?? []).map(cleanString).filter(Boolean))].sort();
    return { event_types: eventTypes, ...(value.metadata ? { metadata: parseObject(value.metadata) } : {}), type: "external_thread_event" };
  }
  throw new Error("unsupported automation watch condition");
}

export function normalizeSubject(db: RunnerDatabase, value: AutomationWatchSubject, projectID: string): AutomationWatchSubject {
  if (value?.kind === "issues") {
    const ids = [...new Set((value.issue_ids ?? []).filter((id) => Number.isSafeInteger(id) && id > 0))].sort((a, b) => a - b);
    if (ids.length === 0) throw new Error("issue watch requires issue targets");
    for (const id of ids) {
      const issue = getIssue(db, id);
      if (!issue || issue.project_id !== projectID) throw new Error(`issue ${id} is not in watch project`);
    }
    return { issue_ids: ids, kind: "issues" };
  }
  if (value?.kind === "external_thread") {
    const provider = cleanString(value.provider);
    const threadID = cleanString(value.thread_id);
    if (provider === "" || threadID === "") throw new Error("external thread watch requires provider and thread_id");
    return { kind: "external_thread", provider, thread_id: threadID };
  }
  throw new Error("unsupported automation watch subject");
}

export function normalizeNotificationTarget(
  value: Partial<AutomationWatchNotificationTarget> & LegacyAutomationWatchNotificationTarget,
  required: boolean
): AutomationWatchNotificationTarget {
  const target = {
    connector_id: cleanString(value.connector_id) || cleanString(value.channel),
    conversation_id: cleanString(value.conversation_id) || cleanString(value.chat_id),
    reply_to_message_id: cleanString(value.reply_to_message_id) || cleanString(value.message_id),
    thread_id: cleanString(value.thread_id)
  };
  if (target.connector_id === "") throw new Error("automation watch notification connector_id is required");
  if (required && target.conversation_id === "" && target.reply_to_message_id === "" && target.thread_id === "") {
    throw new Error("automation watch notification target is required");
  }
  return target;
}

export function assertAllowedAudit(audit: AutomationAudit): void {
  if (!cleanString(audit.actor_id) || !cleanString(audit.correlation_id) || !cleanString(audit.event_id) || !cleanString(audit.reason)) {
    throw new Error("automation watch audit identity, correlation, event, and reason are required");
  }
  if (audit.gate.decision !== "allow" || !["deterministic_policy", "human_approval"].includes(audit.gate.authority)) {
    throw new Error("automation watch mutation requires a deterministic or human allow gate");
  }
  if (!cleanString(audit.gate.policy_ref)) throw new Error("automation watch audit policy_ref is required");
  normalizeTimestamp(audit.occurred_at);
}

export function projectExists(db: RunnerDatabase, id: string): boolean {
  return Boolean(db.sqlite.query<{ id: string }, [string]>("select id from projects where id=?").get(id));
}

export function tableExists(db: RunnerDatabase, table: string): boolean {
  return Boolean(db.sqlite.query<{ name: string }, [string]>(
    "select name from sqlite_master where type='table' and name=?"
  ).get(table));
}

export function optionalTimestamp(value: unknown): string {
  const text = cleanString(value);
  return text === "" ? "" : normalizeTimestamp(text);
}

export function parseObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== "string" || value.trim() === "") return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch { return {}; }
}

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function watchStatus(value: unknown): AutomationWatchStatus {
  const status = cleanString(value) as AutomationWatchStatus;
  return ["watching", "satisfied", "notified", "expired", "cancelled", "failed"].includes(status) ? status : "failed";
}

function watchOutcome(value: unknown): AutomationWatchOutcome {
  const outcome = cleanString(value) as AutomationWatchOutcome;
  return ["", "completion", "failure", "cancelled", "thread_event", "timeout"].includes(outcome) ? outcome : "";
}
