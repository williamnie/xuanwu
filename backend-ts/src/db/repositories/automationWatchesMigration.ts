import { createHash } from "node:crypto";
import type { RunnerDatabase } from "../database.ts";
import { createAutomation, getAutomation, transitionAutomationStatus } from "./automations.ts";
import { getPiIssueCompletionWatch, type PiIssueCompletionWatch } from "./pi.ts";
import { type AutomationAudit, type AutomationID } from "../../domain/automation/contracts.ts";
import { INVESTIGATE_WORKFLOW_REF } from "../../workflows/investigate.ts";
import { cleanString } from "../../util/values.ts";
import {
  type LegacyWatchMigrationResult,
  assertAllowedAudit,
  tableExists,
  TABLE,
  type DesiredShadow,
  type AutomationWatch,
  stableJson,
  parseObject,
  TERMINAL_STATUSES,
  type AutomationWatchCondition,
  normalizeNotificationTarget,
  type Row,
  COLUMNS,
  mapWatch,
  type AutomationWatchSubject,
  type AutomationWatchStatus,
  type AutomationWatchOutcome,
  optionalTimestamp
} from "./automationWatchesModel.ts";
import { triggerFor, insertWatch, recordWatchEvent, normalizeNativeInput } from "./automationWatchesStorage.ts";

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
    ? parsed.terminal_statuses.map(cleanString).filter((item) => TERMINAL_STATUSES.has(item))
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
      connector_id: cleanString(legacy.target_channel) || "feishu",
      conversation_id: legacy.target_chat_id,
      reply_to_message_id: legacy.target_message_id,
      thread_id: legacy.target_thread_id
    }, false),
    outcome: legacyOutcome(legacy),
    status,
    subject: { issue_ids: legacy.items.map((item) => item.issue_id).sort((a, b) => a - b), kind: "issues" }
  };
}

export function archiveDefinition(db: RunnerDatabase, automationID: AutomationID, audit: AutomationAudit): void {
  const definition = getAutomation(db, automationID);
  if (!definition || definition.status === "archived") return;
  transitionAutomationStatus(db, automationID, {
    audit,
    expected_revision: definition.revision,
    status: "archived"
  });
}

export function sameWatch(
  db: RunnerDatabase,
  existing: AutomationWatch,
  desired: ReturnType<typeof normalizeNativeInput>
): boolean {
  const definition = getAutomation(db, existing.automation_id);
  return definition?.owner.kind === "project" && definition.owner.project_id === desired.projectID &&
    definition.name === desired.name && existing.migration_mode === "native" && existing.dedupe_key === desired.dedupeKey &&
    existing.expires_at === desired.expiresAt &&
    existing.condition_json === stableJson(desired.condition) && existing.subject_json === stableJson(desired.subject) &&
    stableJson(existing.notification_target) === stableJson(desired.notificationTarget);
}

function sameShadow(existing: AutomationWatch, desired: DesiredShadow): boolean {
  return existing.migration_mode === "legacy_shadow" && existing.condition_json === stableJson(desired.condition) &&
    existing.subject_json === stableJson(desired.subject) &&
    stableJson(existing.notification_target) === stableJson(desired.notificationTarget) &&
    existing.expires_at === desired.expiresAt && existing.status === desired.status &&
    existing.outcome === desired.outcome && existing.satisfied_at === desired.legacy.completed_at &&
    existing.notified_at === desired.legacy.notified_at && existing.error === desired.legacy.error;
}

export function findAutomationWatchByDedupe(db: RunnerDatabase, key: string): AutomationWatch | null {
  const row = db.sqlite.query<Row, [string]>(`select ${COLUMNS} from ${TABLE} where dedupe_key=?`).get(key);
  return row ? mapWatch(row) : null;
}

function findShadowByLegacyID(db: RunnerDatabase, id: string): AutomationWatch | null {
  const row = db.sqlite.query<Row, [string]>(`select ${COLUMNS} from ${TABLE} where legacy_watch_id=?`).get(id);
  return row ? mapWatch(row) : null;
}

export function initialExternalEventCursor(db: RunnerDatabase, subject: AutomationWatchSubject): number {
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
  const slug = cleanString(id).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  const hash = createHash("sha256").update(id).digest("hex").slice(0, 12);
  return `automation:watch-legacy-${(slug || "watch").slice(0, 80)}-${hash}` as AutomationID;
}

function derivedAudit(audit: AutomationAudit, index: number, suffix: string): AutomationAudit {
  return { ...audit, event_id: `${audit.event_id}:${index}:${suffix}` };
}
