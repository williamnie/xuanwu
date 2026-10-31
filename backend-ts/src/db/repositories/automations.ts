import type { RunnerDatabase } from "../database.ts";
import {
  applyAutomationStatusCommand,
  assertAutomationDefinition,
  normalizeTimestamp,
  type AutomationAudit,
  type AutomationDefinition,
  type AutomationID,
  type AutomationStatusCommand,
  type AutomationTriggerConfig,
  type VersionedAutomationTrigger
} from "../../domain/automation/contracts.ts";
import {
  type CreateAutomationInput,
  normalizeOptionalTimestamp,
  assertAllowedAudit,
  assertTrigger,
  definitionValues,
  insertTrigger,
  requireAutomation,
  type AutomationDefinitionPatch,
  type AutomationListFilter,
  type Row,
  mapDefinition,
  mapTrigger
} from "./automationsModel.ts";
import { insertEvent } from "./automationsEvents.ts";

export function createAutomation(
  db: RunnerDatabase,
  input: CreateAutomationInput,
  now = new Date().toISOString(),
  audit?: AutomationAudit
): AutomationDefinition {
  const timestamp = normalizeTimestamp(now);
  const definition: AutomationDefinition = {
    ...input,
    active_trigger_version: 1,
    created_at: timestamp,
    next_run_at: normalizeOptionalTimestamp(input.next_run_at),
    revision: 0,
    updated_at: timestamp
  };
  assertAutomationDefinition(definition);
  if (audit) assertAllowedAudit(audit);
  const trigger: VersionedAutomationTrigger = {
    ...input.trigger, automation_id: definition.id, created_at: timestamp,
    created_by: input.trigger_created_by, version: 1
  };
  assertTrigger(trigger);
  db.transaction(() => {
    db.sqlite.run(`insert into automation_definitions (
      id, scope_kind, scope_id, name, workflow_ref, permission_policy_ref, mode, status,
      idempotency_namespace, active_trigger_version, next_run_at, revision, created_at, updated_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, definitionValues(definition));
    insertTrigger(db, trigger);
    if (audit) insertEvent(db, definition.id, "automation.created.v1", 0, 0, 0, audit, {
      status: definition.status,
      trigger_type: trigger.type,
      trigger_version: trigger.version
    });
  })();
  return requireAutomation(db, definition.id);
}

export function updateAutomationDefinition(
  db: RunnerDatabase,
  id: AutomationID,
  patch: AutomationDefinitionPatch,
  expectedRevision: number,
  audit: AutomationAudit
): AutomationDefinition {
  const current = requireAutomation(db, id);
  assertAllowedAudit(audit);
  if (expectedRevision !== current.revision) throw new Error("automation revision conflict");
  const next: AutomationDefinition = {
    ...current,
    ...patch,
    next_run_at: patch.next_run_at === undefined ? current.next_run_at : normalizeOptionalTimestamp(patch.next_run_at),
    revision: current.revision + 1,
    updated_at: normalizeTimestamp(audit.occurred_at)
  };
  assertAutomationDefinition(next);
  db.transaction(() => {
    db.sqlite.run(`update automation_definitions set name=?, workflow_ref=?, permission_policy_ref=?, mode=?,
      next_run_at=?, revision=?, updated_at=? where id=? and revision=?`, [
      next.name, next.workflow_ref, next.permission_policy_ref, next.mode, next.next_run_at,
      next.revision, next.updated_at, id, current.revision
    ]);
    if ((db.sqlite.query("select changes() as count").get() as { count: number }).count !== 1) {
      throw new Error("automation revision conflict");
    }
    insertEvent(db, id, "automation.definition_updated.v1", expectedRevision, current.revision, next.revision, audit, {
      changed_fields: Object.keys(patch).sort()
    });
  })();
  return requireAutomation(db, id);
}

export function reviseAutomationTrigger(
  db: RunnerDatabase,
  id: AutomationID,
  trigger: AutomationTriggerConfig,
  audit: AutomationAudit,
  nextRunAt?: string | null,
  expectedRevision?: number
): AutomationDefinition {
  const current = requireAutomation(db, id);
  assertAllowedAudit(audit);
  if (expectedRevision !== undefined && expectedRevision !== current.revision) throw new Error("automation revision conflict");
  const version = current.active_trigger_version + 1;
  const timestamp = normalizeTimestamp(audit.occurred_at);
  const versioned: VersionedAutomationTrigger = {
    ...trigger, automation_id: id, created_at: timestamp, created_by: audit.actor_id, version
  };
  assertTrigger(versioned);
  const next = normalizeOptionalTimestamp(nextRunAt);
  db.transaction(() => {
    insertTrigger(db, versioned);
    db.sqlite.run(`update automation_definitions set active_trigger_version=?, next_run_at=?, revision=?, updated_at=?
      where id=? and revision=?`, [version, next, current.revision + 1, timestamp, id, current.revision]);
    if ((db.sqlite.query("select changes() as count").get() as { count: number }).count !== 1) {
      throw new Error("automation revision conflict");
    }
    insertEvent(db, id, "automation.trigger_revised.v1", current.revision, current.revision, current.revision + 1, audit, {
      trigger_version: version, trigger_type: trigger.type
    });
  })();
  return requireAutomation(db, id);
}

export function transitionAutomationStatus(
  db: RunnerDatabase,
  id: AutomationID,
  command: AutomationStatusCommand
): AutomationDefinition {
  const current = requireAutomation(db, id);
  const next = applyAutomationStatusCommand(current, command);
  db.transaction(() => {
    db.sqlite.run(`update automation_definitions set status=?, revision=?, updated_at=? where id=? and revision=?`, [
      next.status, next.revision, next.updated_at, id, current.revision
    ]);
    if ((db.sqlite.query("select changes() as count").get() as { count: number }).count !== 1) {
      throw new Error("automation revision conflict");
    }
    insertEvent(db, id, "automation.status_changed.v1", command.expected_revision, current.revision, next.revision, command.audit, {
      after_status: next.status, before_status: current.status
    });
  })();
  return requireAutomation(db, id);
}

export function listAutomations(db: RunnerDatabase, filter: AutomationListFilter = {}): AutomationDefinition[] {
  const clauses: string[] = [];
  const values: string[] = [];
  if (filter.project_id) {
    clauses.push("d.scope_kind='project' and d.scope_id=?");
    values.push(filter.project_id);
  }
  if (filter.status) {
    clauses.push("d.status=?");
    values.push(filter.status);
  }
  if (filter.trigger_type) {
    clauses.push("c.trigger_type=?");
    values.push(filter.trigger_type);
  }
  const where = clauses.length > 0 ? ` where ${clauses.join(" and ")}` : "";
  return db.sqlite.query<Row, string[]>(`select d.* from automation_definitions d
    join automation_trigger_configs c on c.automation_id=d.id and c.version=d.active_trigger_version
    ${where} order by d.updated_at desc, d.id asc limit 500`).all(...values).map(mapDefinition);
}

export function getAutomationTrigger(
  db: RunnerDatabase,
  id: AutomationID,
  version?: number
): VersionedAutomationTrigger | null {
  const row = version === undefined
    ? db.sqlite.query<Row, [string]>(`select c.* from automation_trigger_configs c join automation_definitions d
      on d.id=c.automation_id and d.active_trigger_version=c.version where c.automation_id=?`).get(id)
    : db.sqlite.query<Row, [string, number]>(`select * from automation_trigger_configs where automation_id=? and version=?`).get(id, version);
  return row ? mapTrigger(row) : null;
}

export type { AutomationDefinitionPatch } from "./automationsModel.ts";
export type { AutomationListFilter } from "./automationsModel.ts";
export { getAutomation } from "./automationsModel.ts";
export { listAutomationRuns } from "./automationsEvents.ts";
export { listAutomationEvents } from "./automationsEvents.ts";
export { recordAutomationEvent } from "./automationsEvents.ts";
export { recordAutomationRun } from "./automationsEvents.ts";
