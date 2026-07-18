import type { RunnerDatabase } from "../database.ts";
import {
  applyAutomationStatusCommand,
  assertAutomationDefinition,
  normalizeTimestamp,
  validateVersionedAutomationTrigger,
  type AutomationAudit,
  type AutomationDefinition,
  type AutomationID,
  type AutomationRun,
  type AutomationRunStatus,
  type AutomationScope,
  type AutomationStatusCommand,
  type AutomationTriggerConfig,
  type VersionedAutomationTrigger
} from "../../domain/automation/contracts.ts";

type Row = Record<string, unknown>;

export type CreateAutomationInput = Omit<AutomationDefinition, "active_trigger_version" | "created_at" | "revision" | "updated_at"> & {
  next_run_at?: string | null;
  trigger: AutomationTriggerConfig;
  trigger_created_by: string;
};

export type AutomationDefinitionPatch = Partial<Pick<AutomationDefinition,
  "mode" | "name" | "next_run_at" | "permission_policy_ref" | "workflow_ref"
>>;

export type AutomationEvent = {
  actor_id: string;
  actor_kind: AutomationAudit["actor_kind"];
  after_revision: number;
  automation_id: AutomationID;
  before_revision: number;
  correlation_id: string;
  event_id: string;
  event_type: string;
  expected_revision: number;
  gate_authority: AutomationAudit["gate"]["authority"];
  gate_decision: AutomationAudit["gate"]["decision"];
  gate_policy_ref: string;
  occurred_at: string;
  payload: Record<string, unknown>;
  reason: string;
};

export type AutomationListFilter = {
  project_id?: string;
  status?: AutomationDefinition["status"];
  trigger_type?: AutomationTriggerConfig["type"];
};

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

export function getAutomation(db: RunnerDatabase, id: AutomationID): AutomationDefinition | null {
  const row = db.sqlite.query<Row, [string]>(`select * from automation_definitions where id=?`).get(id);
  return row ? mapDefinition(row) : null;
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

function requireAutomation(db: RunnerDatabase, id: AutomationID): AutomationDefinition {
  const definition = getAutomation(db, id);
  if (!definition) throw new Error(`automation ${id} not found`);
  return definition;
}

function definitionValues(definition: AutomationDefinition): unknown[] {
  return [
    definition.id, definition.owner.kind, scopeID(definition.owner), definition.name, definition.workflow_ref,
    definition.permission_policy_ref, definition.mode, definition.status, definition.idempotency_namespace,
    definition.active_trigger_version, definition.next_run_at, definition.revision, definition.created_at, definition.updated_at
  ];
}

function scopeID(scope: AutomationScope): string {
  return scope.kind === "project" ? scope.project_id : scope.control_plane_id;
}

function insertTrigger(db: RunnerDatabase, trigger: VersionedAutomationTrigger): void {
  db.sqlite.run(`insert into automation_trigger_configs
    (automation_id, version, trigger_type, config_json, created_by, created_at) values (?, ?, ?, ?, ?, ?)`, [
    trigger.automation_id, trigger.version, trigger.type, JSON.stringify(trigger.config), trigger.created_by, trigger.created_at
  ]);
}

function insertEvent(
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

function assertTrigger(trigger: VersionedAutomationTrigger): void {
  const errors = validateVersionedAutomationTrigger(trigger);
  if (errors.length > 0) throw new Error(errors.join("; "));
}

function assertAllowedAudit(audit: AutomationAudit): void {
  if (audit.gate.decision !== "allow" || !["deterministic_policy", "human_approval"].includes(audit.gate.authority)) {
    throw new Error("automation mutation requires an allowed deterministic policy or human approval gate");
  }
  if (!audit.event_id.trim() || !audit.actor_id.trim() || !audit.correlation_id.trim() || !audit.reason.trim() || !audit.gate.policy_ref.trim()) {
    throw new Error("automation audit identity, reason, correlation, and policy are required");
  }
  normalizeTimestamp(audit.occurred_at);
}

function mapDefinition(row: Row): AutomationDefinition {
  return {
    active_trigger_version: number(row.active_trigger_version), created_at: text(row.created_at),
    id: text(row.id) as AutomationID, idempotency_namespace: text(row.idempotency_namespace), mode: text(row.mode) as AutomationDefinition["mode"],
    name: text(row.name), next_run_at: nullableText(row.next_run_at), owner: mapScope(text(row.scope_kind), text(row.scope_id)),
    permission_policy_ref: text(row.permission_policy_ref), revision: number(row.revision), status: text(row.status) as AutomationDefinition["status"],
    updated_at: text(row.updated_at), workflow_ref: text(row.workflow_ref)
  };
}

function mapTrigger(row: Row): VersionedAutomationTrigger {
  const type = text(row.trigger_type) as AutomationTriggerConfig["type"];
  const base = { automation_id: text(row.automation_id) as AutomationID, created_at: text(row.created_at), created_by: text(row.created_by), version: number(row.version) };
  return { ...base, type, config: JSON.parse(text(row.config_json)) } as VersionedAutomationTrigger;
}

function mapRun(row: Row): AutomationRun {
  return {
    automation_id: text(row.automation_id) as AutomationID, completed_at: nullableText(row.completed_at),
    created_at: text(row.created_at), idempotency_key: text(row.idempotency_key), requested_at: text(row.requested_at),
    run_id: text(row.run_id), status: text(row.status) as AutomationRunStatus, summary: JSON.parse(text(row.summary_json)), trigger_version: number(row.trigger_version)
  };
}

function mapEvent(row: Row): AutomationEvent {
  return {
    actor_id: text(row.actor_id), actor_kind: text(row.actor_kind) as AutomationEvent["actor_kind"],
    after_revision: number(row.after_revision), automation_id: text(row.automation_id) as AutomationID,
    before_revision: number(row.before_revision), correlation_id: text(row.correlation_id), event_id: text(row.event_id),
    event_type: text(row.event_type), expected_revision: number(row.expected_revision),
    gate_authority: text(row.gate_authority) as AutomationEvent["gate_authority"],
    gate_decision: text(row.gate_decision) as AutomationEvent["gate_decision"], gate_policy_ref: text(row.gate_policy_ref),
    occurred_at: text(row.occurred_at), payload: JSON.parse(text(row.payload_json)), reason: text(row.reason)
  };
}

function mapScope(kind: string, id: string): AutomationScope {
  return kind === "project" ? { kind, project_id: id } : { kind: "control_plane", control_plane_id: "local" };
}
function normalizeOptionalTimestamp(value: string | null | undefined): string | null { return value ? normalizeTimestamp(value) : null; }
function text(value: unknown): string { return typeof value === "string" ? value : ""; }
function nullableText(value: unknown): string | null { const result = text(value); return result ? result : null; }
function number(value: unknown): number { return typeof value === "number" ? value : Number(value); }
function isRunStatus(value: string): value is AutomationRunStatus { return ["queued", "running", "succeeded", "failed", "skipped"].includes(value); }
