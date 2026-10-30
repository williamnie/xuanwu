import type { RunnerDatabase } from "../database.ts";
import {
  normalizeTimestamp,
  type AutomationAudit,
  type AutomationID,
  type AutomationRun
} from "../../domain/automation/contracts.ts";
import {
  type Row,
  mapRun,
  type AutomationEvent,
  mapEvent,
  requireAutomation,
  assertAllowedAudit,
  isRunStatus
} from "./automationsModel.ts";

export function listAutomationRuns(db: RunnerDatabase, id: AutomationID): AutomationRun[] {
  return db.sqlite.query<Row, [string]>(`select * from automation_runs where automation_id=? order by created_at desc, run_id desc`)
    .all(id).map(mapRun);
}

export function listAutomationEvents(db: RunnerDatabase, id: AutomationID): AutomationEvent[] {
  return db.sqlite.query<Row, [string]>(`select * from automation_events where automation_id=?
    order by occurred_at desc, event_id desc`).all(id).map(mapEvent);
}

export function recordAutomationEvent(
  db: RunnerDatabase,
  id: AutomationID,
  eventType: string,
  audit: AutomationAudit,
  payload: Record<string, unknown> = {}
): AutomationEvent {
  const current = requireAutomation(db, id);
  assertAllowedAudit(audit);
  insertEvent(db, id, eventType, current.revision, current.revision, current.revision, audit, payload);
  return listAutomationEvents(db, id).find((event) => event.event_id === audit.event_id)!;
}

export function recordAutomationRun(
  db: RunnerDatabase,
  run: AutomationRun
): AutomationRun {
  const definition = requireAutomation(db, run.automation_id);
  if (run.trigger_version > definition.active_trigger_version || run.trigger_version < 1) {
    throw new Error("automation run references an unknown trigger version");
  }
  if (!/^automation-run:[a-zA-Z0-9._:-]+$/.test(run.run_id) || !run.idempotency_key.trim()) {
    throw new Error("automation run_id and idempotency_key are required");
  }
  if (!isRunStatus(run.status)) throw new Error("automation run status is invalid");
  const requestedAt = normalizeTimestamp(run.requested_at);
  const completedAt = run.completed_at === null ? null : normalizeTimestamp(run.completed_at);
  const createdAt = normalizeTimestamp(run.created_at);
  db.sqlite.run(`insert into automation_runs (
    run_id, automation_id, trigger_version, idempotency_key, status, requested_at, completed_at, summary_json, created_at
  ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
    run.run_id, run.automation_id, run.trigger_version, run.idempotency_key, run.status,
    requestedAt, completedAt, JSON.stringify(run.summary), createdAt
  ]);
  return listAutomationRuns(db, run.automation_id).find((item) => item.run_id === run.run_id)!;
}

export function insertEvent(
  db: RunnerDatabase,
  id: AutomationID,
  eventType: string,
  expectedRevision: number,
  beforeRevision: number,
  afterRevision: number,
  audit: AutomationAudit,
  payload: Record<string, unknown>
): void {
  db.sqlite.run(`insert into automation_events (
    event_id, automation_id, event_type, expected_revision, before_revision, after_revision,
    actor_id, actor_kind, correlation_id, gate_authority, gate_decision, gate_policy_ref,
    reason, payload_json, occurred_at
  ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
    audit.event_id, id, eventType, expectedRevision, beforeRevision, afterRevision,
    audit.actor_id, audit.actor_kind, audit.correlation_id, audit.gate.authority, audit.gate.decision,
    audit.gate.policy_ref, audit.reason, JSON.stringify(payload), normalizeTimestamp(audit.occurred_at)
  ]);
}
