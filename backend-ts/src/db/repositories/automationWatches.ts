import type { RunnerDatabase } from "../database.ts";
import { createAutomation } from "./automations.ts";
import { type AutomationAudit, type AutomationID } from "../../domain/automation/contracts.ts";
import { INVESTIGATE_WORKFLOW_REF } from "../../workflows/investigate.ts";
import {
  type CreateAutomationWatchInput,
  type AutomationWatch,
  assertAllowedAudit,
  type Row,
  TABLE,
  mapWatch,
  type AutomationWatchOutcome
} from "./automationWatchesModel.ts";
import {
  normalizeNativeInput,
  triggerFor,
  insertWatch,
  recordWatchEvent,
  requireAutomationWatch
} from "./automationWatchesStorage.ts";
import {
  findAutomationWatchByDedupe,
  sameWatch,
  initialExternalEventCursor,
  archiveDefinition
} from "./automationWatchesMigration.ts";

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

export type { AutomationWatchOutcome } from "./automationWatchesModel.ts";
export type { AutomationWatch } from "./automationWatchesModel.ts";
export type { CreateAutomationWatchInput } from "./automationWatchesModel.ts";
export { getAutomationWatch } from "./automationWatchesStorage.ts";
export { migrateLegacyCompletionWatches } from "./automationWatchesMigration.ts";
