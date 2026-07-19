import { createHash } from "node:crypto";
import type { RunnerDatabase } from "../database.ts";
import {
  createAutomation,
  getAutomation,
  transitionAutomationStatus
} from "./automations.ts";
import { getIssue } from "./issues.ts";
import { getPiIssueCompletionWatch, type PiIssueCompletionWatch } from "./pi.ts";
import {
  normalizeTimestamp,
  type AutomationAudit,
  type AutomationID
} from "../../domain/automation/contracts.ts";
import { INVESTIGATE_WORKFLOW_REF } from "../../workflows/investigate.ts";

export type AutomationWatchStatus = "watching" | "satisfied" | "notified" | "expired" | "cancelled" | "failed";
export type AutomationWatchOutcome = "" | "completion" | "failure" | "cancelled" | "thread_event" | "timeout";
export type AutomationWatchCondition =
  | { match: "all" | "any"; metadata?: Record<string, unknown>; statuses: string[]; type: "issue_status" }
  | { event_types: string[]; metadata?: Record<string, unknown>; type: "external_thread_event" };
export type AutomationWatchSubject =
  | { issue_ids: number[]; kind: "issues" }
  | { kind: "external_thread"; provider: string; thread_id: string };
export type AutomationWatchNotificationTarget = {
  channel: "feishu";
  chat_id: string;
  message_id: string;
  thread_id: string;
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

type Row = Record<string, unknown>;
type StoredWatch = Omit<AutomationWatch, "condition" | "notification_target" | "subject">;
type DesiredShadow = {
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

const TABLE = "automation_watches";
const COLUMNS = `automation_id, migration_mode, legacy_watch_id, condition_json,
  subject_json, notification_target_json, dedupe_key, expires_at, status,
  outcome, matched_ref, last_external_event_id, satisfied_at, notified_at,
  error, created_at, updated_at`;
const TERMINAL_STATUSES = new Set(["done", "failed", "cancelled", "pending_verification"]);

export function createAutomationWatch(
  db: RunnerDatabase,
  input: CreateAutomationWatchInput,
  audit: AutomationAudit
): AutomationWatch {
  assertAllowedAudit(audit);
  const normalized = normalizeNativeInput(db, input, audit);
  const existing = findAutomationWatchByDedupe(db, normalized.dedupeKey);
  if (existing) {
    if (!sameWatch(db, existing, normalized)) throw new Error("automation watch dedupe conflict");
    return existing;
  }
  const write = db.transaction(() => {
    createAutomation(db, {
      id: normalized.automationID,
      idempotency_namespace: normalized.dedupeKey,
      mode: "observe",
      name: normalized.name,
      next_run_at: null,
      owner: { kind: "project", project_id: normalized.projectID },
      permission_policy_ref: `project-policy:${normalized.projectID}`,
      status: "active",
      trigger: triggerFor(normalized.condition),
      trigger_created_by: audit.actor_id,
      workflow_ref: INVESTIGATE_WORKFLOW_REF
    }, audit.occurred_at);
    insertWatch(db, {
      automationID: normalized.automationID,
      condition: normalized.condition,
      dedupeKey: normalized.dedupeKey,
      expiresAt: normalized.expiresAt,
      lastExternalEventID: initialExternalEventCursor(db, normalized.subject),
      legacyWatchID: "",
      migrationMode: "native",
      notificationTarget: normalized.notificationTarget,
      outcome: "",
      status: "watching",
      subject: normalized.subject,
      timestamp: audit.occurred_at
    });
    recordWatchEvent(db, normalized.automationID, "automation.watch_created.v1", audit, {
      dedupe_key: normalized.dedupeKey,
      expires_at: normalized.expiresAt,
      migration_mode: "native"
    });
  });
  write.immediate();
  return requireAutomationWatch(db, normalized.automationID);
}

export function getAutomationWatch(db: RunnerDatabase, id: AutomationID): AutomationWatch | null {
  const row = db.sqlite.query<Row, [string]>(`select ${COLUMNS} from ${TABLE} where automation_id=?`).get(id);
  return row ? mapWatch(row) : null;
}

export function listWatchingAutomationWatches(db: RunnerDatabase): AutomationWatch[] {
  return db.sqlite.query<Row, []>(`select w.*
    from ${TABLE} w join automation_definitions d on d.id=w.automation_id
    where w.migration_mode='native' and w.status='watching' and d.status='active'
    order by w.created_at asc, w.automation_id asc`).all().map(mapWatch);
}

export function listPendingAutomationWatchDeliveries(db: RunnerDatabase): AutomationWatch[] {
  return db.sqlite.query<Row, []>(`select * from ${TABLE}
    where migration_mode='native' and status in ('satisfied', 'expired')
    order by satisfied_at asc, automation_id asc`).all().map(mapWatch);
}

export function listAutomationIssueWatches(db: RunnerDatabase): AutomationWatch[] {
  return db.sqlite.query<Row, []>(`select * from ${TABLE}
    where migration_mode='native' and json_extract(subject_json, '$.kind')='issues'
    order by created_at desc, automation_id desc`).all().map(mapWatch);
}

export function cancelAutomationWatch(
  db: RunnerDatabase,
  id: AutomationID,
  audit: AutomationAudit
): AutomationWatch {
  assertAllowedAudit(audit);
  const current = requireAutomationWatch(db, id);
  if (current.migration_mode !== "native") throw new Error("legacy shadow watch must be cancelled through the legacy authority");
  if (current.status === "cancelled") return current;
  if (current.status !== "watching") throw new Error(`automation watch cannot be cancelled from ${current.status}`);
  const write = db.transaction(() => {
    archiveDefinition(db, current.automation_id, audit);
    db.sqlite.run(`update ${TABLE} set status='cancelled', outcome='cancelled', updated_at=?
      where automation_id=? and status='watching'`, [audit.occurred_at, current.automation_id]);
    recordWatchEvent(db, current.automation_id, "automation.watch_cancelled.v1", audit, {});
  });
  write.immediate();
  return requireAutomationWatch(db, id);
}

export function updateAutomationWatchCursor(
  db: RunnerDatabase,
  watch: AutomationWatch,
  lastExternalEventID: number,
  audit: AutomationAudit
): AutomationWatch {
  assertAllowedAudit(audit);
  const current = requireAutomationWatch(db, watch.automation_id);
  if (lastExternalEventID <= current.last_external_event_id || current.status !== "watching") return current;
  db.sqlite.run(`update ${TABLE} set last_external_event_id=?, updated_at=?
    where automation_id=? and status='watching' and last_external_event_id<?`, [
    lastExternalEventID, audit.occurred_at, current.automation_id, lastExternalEventID
  ]);
  recordWatchEvent(db, current.automation_id, "automation.watch_cursor_advanced.v1", audit, {
    after_external_event_id: lastExternalEventID,
    before_external_event_id: current.last_external_event_id
  });
  return requireAutomationWatch(db, current.automation_id);
}

export function markAutomationWatchTerminal(
  db: RunnerDatabase,
  watch: AutomationWatch,
  input: { matchedRef: string; outcome: Exclude<AutomationWatchOutcome, "">; status: "satisfied" | "expired" },
  audit: AutomationAudit
): AutomationWatch {
  assertAllowedAudit(audit);
  const current = requireAutomationWatch(db, watch.automation_id);
  if (current.status !== "watching") return current;
  archiveDefinition(db, current.automation_id, audit);
  db.sqlite.run(`update ${TABLE} set status=?, outcome=?, matched_ref=?,
    satisfied_at=case when satisfied_at='' then ? else satisfied_at end, updated_at=?
    where automation_id=? and status='watching'`, [
    input.status, input.outcome, input.matchedRef, audit.occurred_at, audit.occurred_at, current.automation_id
  ]);
  recordWatchEvent(db, current.automation_id, `automation.watch_${input.status}.v1`, audit, {
    matched_ref: input.matchedRef,
    outcome: input.outcome
  });
  return requireAutomationWatch(db, current.automation_id);
}

export function markAutomationWatchNotified(
  db: RunnerDatabase,
  watch: AutomationWatch,
  audit: AutomationAudit
): AutomationWatch {
  assertAllowedAudit(audit);
  if (watch.status === "notified") return watch;
  if (!["satisfied", "expired"].includes(watch.status)) throw new Error("automation watch is not ready for notification");
  db.sqlite.run(`update ${TABLE} set status='notified', notified_at=case when notified_at='' then ? else notified_at end,
    updated_at=?, error='' where automation_id=? and status in ('satisfied', 'expired')`, [
    audit.occurred_at, audit.occurred_at, watch.automation_id
  ]);
  recordWatchEvent(db, watch.automation_id, "automation.watch_delivery_confirmed.v1", audit, {
    outcome: watch.outcome
  });
  return requireAutomationWatch(db, watch.automation_id);
}

export function recordAutomationWatchNotificationQueued(
  db: RunnerDatabase,
  watch: AutomationWatch,
  audit: AutomationAudit
): void {
  assertAllowedAudit(audit);
  recordWatchEvent(db, watch.automation_id, "automation.watch_notification_queued.v1", audit, {
    outcome: watch.outcome
  });
}

export function migrateLegacyCompletionWatches(
  db: RunnerDatabase,
  options: { audit: AutomationAudit; dryRun?: boolean }
): LegacyWatchMigrationResult {
  assertAllowedAudit(options.audit);
  const legacyIDs = db.sqlite.query<{ id: string }, []>(
    "select id from pi_issue_completion_watches order by created_at asc, id asc"
  ).all().map((row) => row.id);
  const result: LegacyWatchMigrationResult = { created: 0, refreshed: 0, scanned: legacyIDs.length, unchanged: 0 };
  const watchTableExists = tableExists(db, TABLE);
  if (!watchTableExists && !options.dryRun) throw new Error("automation watch migration is not applied");
  legacyIDs.forEach((id, index) => {
    const legacy = getPiIssueCompletionWatch(db, id);
    if (!legacy) return;
    const desired = desiredShadow(legacy);
    const existing = watchTableExists ? findShadowByLegacyID(db, legacy.id) : null;
    if (!existing) {
      result.created += 1;
      if (!options.dryRun) createShadow(db, desired, derivedAudit(options.audit, index, "created"));
      return;
    }
    if (sameShadow(existing, desired)) {
      result.unchanged += 1;
      return;
    }
    result.refreshed += 1;
    if (!options.dryRun) refreshShadow(db, existing, desired, derivedAudit(options.audit, index, "refreshed"));
  });
  return result;
}

function normalizeNativeInput(db: RunnerDatabase, input: CreateAutomationWatchInput, audit: AutomationAudit) {
  const projectID = clean(input.project_id);
  if (projectID === "" || !projectExists(db, projectID)) throw new Error("automation watch project is required");
  const condition = normalizeCondition(input.condition);
  const subject = normalizeSubject(db, input.subject, projectID);
  if (condition.type === "issue_status" && subject.kind !== "issues") throw new Error("issue condition requires issue targets");
  if (condition.type === "external_thread_event" && subject.kind !== "external_thread") {
    throw new Error("thread condition requires an external thread target");
  }
  const notificationTarget = normalizeNotificationTarget(input.notification_target, input.allow_empty_notification_target !== true);
  const dedupeKey = clean(input.dedupe_key);
  if (dedupeKey === "") throw new Error("automation watch dedupe_key is required");
  const expiresAt = optionalTimestamp(input.expires_at);
  const automationID = input.id ?? `automation:watch-${crypto.randomUUID()}` as AutomationID;
  return {
    automationID,
    condition,
    dedupeKey,
    expiresAt,
    name: clean(input.name) || "Watch Automation",
    notificationTarget,
    projectID,
    subject
  };
}

function createShadow(db: RunnerDatabase, desired: DesiredShadow, audit: AutomationAudit): void {
  const active = desired.status === "watching";
  const write = db.transaction(() => {
    createAutomation(db, {
      id: desired.automationID,
      idempotency_namespace: desired.dedupeKey,
      mode: "observe",
      name: `Legacy completion watch ${desired.legacy.id}`,
      next_run_at: null,
      owner: { kind: "project", project_id: desired.legacy.project_id },
      permission_policy_ref: `project-policy:${desired.legacy.project_id}`,
      status: active ? "active" : "archived",
      trigger: triggerFor(desired.condition),
      trigger_created_by: audit.actor_id,
      workflow_ref: INVESTIGATE_WORKFLOW_REF
    }, audit.occurred_at);
    insertWatch(db, {
      automationID: desired.automationID,
      condition: desired.condition,
      dedupeKey: desired.dedupeKey,
      expiresAt: desired.expiresAt,
      lastExternalEventID: 0,
      legacyWatchID: desired.legacy.id,
      migrationMode: "legacy_shadow",
      notificationTarget: desired.notificationTarget,
      outcome: desired.outcome,
      status: desired.status,
      subject: desired.subject,
      timestamp: audit.occurred_at,
      error: desired.legacy.error,
      notifiedAt: desired.legacy.notified_at,
      satisfiedAt: desired.legacy.completed_at
    });
    recordWatchEvent(db, desired.automationID, "automation.watch_legacy_shadow_created.v1", audit, {
      legacy_watch_id: desired.legacy.id
    });
  });
  write.immediate();
}

function refreshShadow(db: RunnerDatabase, current: AutomationWatch, desired: DesiredShadow, audit: AutomationAudit): void {
  const write = db.transaction(() => {
    const definition = getAutomation(db, current.automation_id);
    if (definition?.status === "active" && desired.status !== "watching") archiveDefinition(db, current.automation_id, audit);
    db.sqlite.run(`update ${TABLE} set condition_json=?, subject_json=?, notification_target_json=?,
      expires_at=?, status=?, outcome=?, satisfied_at=?, notified_at=?, error=?, updated_at=?
      where automation_id=? and migration_mode='legacy_shadow'`, [
      stableJson(desired.condition), stableJson(desired.subject), stableJson(desired.notificationTarget),
      desired.expiresAt, desired.status, desired.outcome, desired.legacy.completed_at,
      desired.legacy.notified_at, desired.legacy.error, audit.occurred_at, current.automation_id
    ]);
    recordWatchEvent(db, current.automation_id, "automation.watch_legacy_shadow_refreshed.v1", audit, {
      legacy_status: desired.legacy.status,
      legacy_watch_id: desired.legacy.id
    });
  });
  write.immediate();
}

function desiredShadow(legacy: PiIssueCompletionWatch): DesiredShadow {
  const parsed = parseObject(legacy.condition);
  const statuses = Array.isArray(parsed.terminal_statuses)
    ? parsed.terminal_statuses.map(clean).filter((item) => TERMINAL_STATUSES.has(item))
    : [];
  const condition: AutomationWatchCondition = {
    match: "all",
    statuses: statuses.length > 0 ? [...new Set(statuses)].sort() : [...TERMINAL_STATUSES].sort(),
    type: "issue_status"
  };
  const status = legacyStatus(legacy.status);
  return {
    automationID: legacyAutomationID(legacy.id),
    condition,
    dedupeKey: `legacy:pi_issue_completion_watch:${legacy.id}`,
    expiresAt: legacyExpiry(parsed),
    legacy,
    notificationTarget: normalizeNotificationTarget({
      channel: "feishu",
      chat_id: legacy.target_chat_id,
      message_id: legacy.target_message_id,
      thread_id: legacy.target_thread_id
    }, false),
    outcome: legacyOutcome(legacy),
    status,
    subject: { issue_ids: legacy.items.map((item) => item.issue_id).sort((a, b) => a - b), kind: "issues" }
  };
}

function insertWatch(db: RunnerDatabase, input: {
  automationID: AutomationID;
  condition: AutomationWatchCondition;
  dedupeKey: string;
  error?: string;
  expiresAt: string;
  lastExternalEventID: number;
  legacyWatchID: string;
  migrationMode: AutomationWatch["migration_mode"];
  notificationTarget: AutomationWatchNotificationTarget;
  notifiedAt?: string;
  outcome: AutomationWatchOutcome;
  satisfiedAt?: string;
  status: AutomationWatchStatus;
  subject: AutomationWatchSubject;
  timestamp: string;
}): void {
  db.sqlite.run(`insert into ${TABLE} (${COLUMNS}) values (${placeholders(17)})`, [
    input.automationID, input.migrationMode, input.legacyWatchID, stableJson(input.condition),
    stableJson(input.subject), stableJson(input.notificationTarget), input.dedupeKey, input.expiresAt,
    input.status, input.outcome, "", input.lastExternalEventID, input.satisfiedAt ?? "",
    input.notifiedAt ?? "", clean(input.error), input.timestamp, input.timestamp
  ]);
}

function recordWatchEvent(
  db: RunnerDatabase,
  automationID: AutomationID,
  eventType: string,
  audit: AutomationAudit,
  payload: Record<string, unknown>
): void {
  const definition = getAutomation(db, automationID);
  if (!definition) throw new Error(`automation ${automationID} not found`);
  db.sqlite.run(`insert into automation_events (
    event_id, automation_id, event_type, expected_revision, before_revision, after_revision,
    actor_id, actor_kind, correlation_id, gate_authority, gate_decision, gate_policy_ref,
    reason, payload_json, occurred_at
  ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
    `${audit.event_id}:${eventType}`, automationID, eventType, definition.revision, definition.revision, definition.revision,
    audit.actor_id, audit.actor_kind, audit.correlation_id, audit.gate.authority, audit.gate.decision,
    audit.gate.policy_ref, audit.reason, stableJson(payload), audit.occurred_at
  ]);
}

function archiveDefinition(db: RunnerDatabase, automationID: AutomationID, audit: AutomationAudit): void {
  const definition = getAutomation(db, automationID);
  if (!definition || definition.status === "archived") return;
  transitionAutomationStatus(db, automationID, {
    audit,
    expected_revision: definition.revision,
    status: "archived"
  });
}

function sameWatch(
  db: RunnerDatabase,
  existing: AutomationWatch,
  desired: ReturnType<typeof normalizeNativeInput>
): boolean {
  const definition = getAutomation(db, existing.automation_id);
  return definition?.owner.kind === "project" && definition.owner.project_id === desired.projectID &&
    definition.name === desired.name && existing.migration_mode === "native" && existing.dedupe_key === desired.dedupeKey &&
    existing.expires_at === desired.expiresAt &&
    existing.condition_json === stableJson(desired.condition) && existing.subject_json === stableJson(desired.subject) &&
    existing.notification_target_json === stableJson(desired.notificationTarget);
}

function sameShadow(existing: AutomationWatch, desired: DesiredShadow): boolean {
  return existing.migration_mode === "legacy_shadow" && existing.condition_json === stableJson(desired.condition) &&
    existing.subject_json === stableJson(desired.subject) &&
    existing.notification_target_json === stableJson(desired.notificationTarget) &&
    existing.expires_at === desired.expiresAt && existing.status === desired.status &&
    existing.outcome === desired.outcome && existing.satisfied_at === desired.legacy.completed_at &&
    existing.notified_at === desired.legacy.notified_at && existing.error === desired.legacy.error;
}

function findAutomationWatchByDedupe(db: RunnerDatabase, key: string): AutomationWatch | null {
  const row = db.sqlite.query<Row, [string]>(`select ${COLUMNS} from ${TABLE} where dedupe_key=?`).get(key);
  return row ? mapWatch(row) : null;
}

function findShadowByLegacyID(db: RunnerDatabase, id: string): AutomationWatch | null {
  const row = db.sqlite.query<Row, [string]>(`select ${COLUMNS} from ${TABLE} where legacy_watch_id=?`).get(id);
  return row ? mapWatch(row) : null;
}

function requireAutomationWatch(db: RunnerDatabase, id: AutomationID): AutomationWatch {
  const watch = getAutomationWatch(db, id);
  if (!watch) throw new Error(`automation watch ${id} not found`);
  return watch;
}

function mapWatch(row: Row): AutomationWatch {
  const stored: StoredWatch = {
    automation_id: clean(row.automation_id) as AutomationID,
    condition_json: clean(row.condition_json) || "{}",
    created_at: clean(row.created_at),
    dedupe_key: clean(row.dedupe_key),
    error: clean(row.error),
    expires_at: clean(row.expires_at),
    last_external_event_id: integer(row.last_external_event_id),
    legacy_watch_id: clean(row.legacy_watch_id),
    matched_ref: clean(row.matched_ref),
    migration_mode: row.migration_mode === "legacy_shadow" ? "legacy_shadow" : "native",
    notification_target_json: clean(row.notification_target_json) || "{}",
    notified_at: clean(row.notified_at),
    outcome: watchOutcome(row.outcome),
    satisfied_at: clean(row.satisfied_at),
    status: watchStatus(row.status),
    subject_json: clean(row.subject_json) || "{}",
    updated_at: clean(row.updated_at)
  };
  return {
    ...stored,
    condition: parseObject(stored.condition_json) as AutomationWatchCondition,
    notification_target: parseObject(stored.notification_target_json) as AutomationWatchNotificationTarget,
    subject: parseObject(stored.subject_json) as AutomationWatchSubject
  };
}

function normalizeCondition(value: AutomationWatchCondition): AutomationWatchCondition {
  if (value?.type === "issue_status") {
    const statuses = [...new Set((value.statuses ?? []).map(clean).filter((item) => TERMINAL_STATUSES.has(item)))].sort();
    if (statuses.length === 0) throw new Error("issue watch requires terminal statuses");
    if (!['all', 'any'].includes(value.match)) throw new Error("issue watch match must be all or any");
    return { match: value.match, ...(value.metadata ? { metadata: parseObject(value.metadata) } : {}), statuses, type: "issue_status" };
  }
  if (value?.type === "external_thread_event") {
    const eventTypes = [...new Set((value.event_types ?? []).map(clean).filter(Boolean))].sort();
    return { event_types: eventTypes, ...(value.metadata ? { metadata: parseObject(value.metadata) } : {}), type: "external_thread_event" };
  }
  throw new Error("unsupported automation watch condition");
}

function normalizeSubject(db: RunnerDatabase, value: AutomationWatchSubject, projectID: string): AutomationWatchSubject {
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
    const provider = clean(value.provider);
    const threadID = clean(value.thread_id);
    if (provider === "" || threadID === "") throw new Error("external thread watch requires provider and thread_id");
    return { kind: "external_thread", provider, thread_id: threadID };
  }
  throw new Error("unsupported automation watch subject");
}

function normalizeNotificationTarget(value: Partial<AutomationWatchNotificationTarget>, required: boolean): AutomationWatchNotificationTarget {
  if (value?.channel !== "feishu") throw new Error("automation watch currently requires a feishu notification target");
  const target = {
    channel: "feishu" as const,
    chat_id: clean(value.chat_id),
    message_id: clean(value.message_id),
    thread_id: clean(value.thread_id)
  };
  if (required && target.chat_id === "" && target.message_id === "") {
    throw new Error("automation watch notification target is required");
  }
  return target;
}

function triggerFor(condition: AutomationWatchCondition) {
  return condition.type === "external_thread_event"
    ? { type: "webhook" as const, config: { event_type: "external.thread_event" } }
    : { type: "continuous" as const, config: { poll_interval_seconds: 30 } };
}

function initialExternalEventCursor(db: RunnerDatabase, subject: AutomationWatchSubject): number {
  if (subject.kind !== "external_thread") return 0;
  return db.sqlite.query<{ id: number }, []>("select coalesce(max(id), 0) as id from external_events").get()?.id ?? 0;
}

function legacyStatus(status: PiIssueCompletionWatch["status"]): AutomationWatchStatus {
  if (status === "active") return "watching";
  if (status === "satisfied") return "satisfied";
  if (status === "notified") return "notified";
  if (status === "cancelled") return "cancelled";
  return "failed";
}

function legacyOutcome(watch: PiIssueCompletionWatch): AutomationWatchOutcome {
  if (watch.status === "active") return "";
  if (watch.status === "cancelled") return "cancelled";
  if (watch.status === "failed") return "failure";
  if (watch.items.some((item) => item.last_status === "failed")) return "failure";
  if (watch.items.some((item) => item.last_status === "cancelled")) return "cancelled";
  return "completion";
}

function legacyExpiry(condition: Record<string, unknown>): string {
  const commitment = condition.commitment;
  if (!commitment || typeof commitment !== "object" || Array.isArray(commitment)) return "";
  return optionalTimestamp((commitment as Record<string, unknown>).due_at);
}

function legacyAutomationID(id: string): AutomationID {
  const slug = clean(id).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  const hash = createHash("sha256").update(id).digest("hex").slice(0, 12);
  return `automation:watch-legacy-${(slug || "watch").slice(0, 80)}-${hash}` as AutomationID;
}

function derivedAudit(audit: AutomationAudit, index: number, suffix: string): AutomationAudit {
  return { ...audit, event_id: `${audit.event_id}:${index}:${suffix}` };
}

function assertAllowedAudit(audit: AutomationAudit): void {
  if (!clean(audit.actor_id) || !clean(audit.correlation_id) || !clean(audit.event_id) || !clean(audit.reason)) {
    throw new Error("automation watch audit identity, correlation, event, and reason are required");
  }
  if (audit.gate.decision !== "allow" || !["deterministic_policy", "human_approval"].includes(audit.gate.authority)) {
    throw new Error("automation watch mutation requires a deterministic or human allow gate");
  }
  if (!clean(audit.gate.policy_ref)) throw new Error("automation watch audit policy_ref is required");
  normalizeTimestamp(audit.occurred_at);
}

function projectExists(db: RunnerDatabase, id: string): boolean {
  return Boolean(db.sqlite.query<{ id: string }, [string]>("select id from projects where id=?").get(id));
}

function tableExists(db: RunnerDatabase, table: string): boolean {
  return Boolean(db.sqlite.query<{ name: string }, [string]>(
    "select name from sqlite_master where type='table' and name=?"
  ).get(table));
}

function optionalTimestamp(value: unknown): string {
  const text = clean(value);
  return text === "" ? "" : normalizeTimestamp(text);
}

function parseObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== "string" || value.trim() === "") return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch { return {}; }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function watchStatus(value: unknown): AutomationWatchStatus {
  const status = clean(value) as AutomationWatchStatus;
  return ["watching", "satisfied", "notified", "expired", "cancelled", "failed"].includes(status) ? status : "failed";
}

function watchOutcome(value: unknown): AutomationWatchOutcome {
  const outcome = clean(value) as AutomationWatchOutcome;
  return ["", "completion", "failure", "cancelled", "thread_event", "timeout"].includes(outcome) ? outcome : "";
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function integer(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}
