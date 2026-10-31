import type { RunnerDatabase } from "../database.ts";
import { getAutomation } from "./automations.ts";
import { type AutomationAudit, type AutomationID } from "../../domain/automation/contracts.ts";
import { cleanString } from "../../util/values.ts";
import { placeholders } from "../sql.ts";
import {
  type AutomationWatch,
  type Row,
  COLUMNS,
  TABLE,
  mapWatch,
  type CreateAutomationWatchInput,
  projectExists,
  normalizeCondition,
  normalizeSubject,
  normalizeNotificationTarget,
  optionalTimestamp,
  type AutomationWatchCondition,
  type AutomationWatchNotificationTarget,
  type AutomationWatchOutcome,
  type AutomationWatchStatus,
  type AutomationWatchSubject,
  stableJson
} from "./automationWatchesModel.ts";

export function getAutomationWatch(db: RunnerDatabase, id: AutomationID): AutomationWatch | null {
  const row = db.sqlite.query<Row, [string]>(`select ${COLUMNS} from ${TABLE} where automation_id=?`).get(id);
  return row ? mapWatch(row) : null;
}

export function normalizeNativeInput(db: RunnerDatabase, input: CreateAutomationWatchInput, audit: AutomationAudit) {
  const projectID = cleanString(input.project_id);
  if (projectID === "" || !projectExists(db, projectID)) throw new Error("automation watch project is required");
  const condition = normalizeCondition(input.condition);
  const subject = normalizeSubject(db, input.subject, projectID);
  if (condition.type === "issue_status" && subject.kind !== "issues") throw new Error("issue condition requires issue targets");
  if (condition.type === "external_thread_event" && subject.kind !== "external_thread") {
    throw new Error("thread condition requires an external thread target");
  }
  const notificationTarget = normalizeNotificationTarget(input.notification_target, input.allow_empty_notification_target !== true);
  const dedupeKey = cleanString(input.dedupe_key);
  if (dedupeKey === "") throw new Error("automation watch dedupe_key is required");
  const expiresAt = optionalTimestamp(input.expires_at);
  const automationID = input.id ?? `automation:watch-${crypto.randomUUID()}` as AutomationID;
  return {
    automationID,
    condition,
    dedupeKey,
    expiresAt,
    name: cleanString(input.name) || "Watch Automation",
    notificationTarget,
    projectID,
    subject
  };
}

export function insertWatch(db: RunnerDatabase, input: {
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
    input.notifiedAt ?? "", cleanString(input.error), input.timestamp, input.timestamp
  ]);
}

export function recordWatchEvent(
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

export function requireAutomationWatch(db: RunnerDatabase, id: AutomationID): AutomationWatch {
  const watch = getAutomationWatch(db, id);
  if (!watch) throw new Error(`automation watch ${id} not found`);
  return watch;
}

export function triggerFor(condition: AutomationWatchCondition) {
  return condition.type === "external_thread_event"
    ? { type: "webhook" as const, config: { event_type: "external.thread_event" } }
    : { type: "continuous" as const, config: { poll_interval_seconds: 30 } };
}
