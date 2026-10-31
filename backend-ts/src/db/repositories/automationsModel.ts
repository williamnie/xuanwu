import type { RunnerDatabase } from "../database.ts";
import {
  normalizeTimestamp,
  validateVersionedAutomationTrigger,
  type AutomationAudit,
  type AutomationDefinition,
  type AutomationID,
  type AutomationRun,
  type AutomationRunStatus,
  type AutomationScope,
  type AutomationTriggerConfig,
  type VersionedAutomationTrigger
} from "../../domain/automation/contracts.ts";

export type Row = Record<string, unknown>;

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

export function getAutomation(db: RunnerDatabase, id: AutomationID): AutomationDefinition | null {
  const row = db.sqlite.query<Row, [string]>(`select * from automation_definitions where id=?`).get(id);
  return row ? mapDefinition(row) : null;
}

export function requireAutomation(db: RunnerDatabase, id: AutomationID): AutomationDefinition {
  const definition = getAutomation(db, id);
  if (!definition) throw new Error(`automation ${id} not found`);
  return definition;
}

export function definitionValues(definition: AutomationDefinition): unknown[] {
  return [
    definition.id, definition.owner.kind, scopeID(definition.owner), definition.name, definition.workflow_ref,
    definition.permission_policy_ref, definition.mode, definition.status, definition.idempotency_namespace,
    definition.active_trigger_version, definition.next_run_at, definition.revision, definition.created_at, definition.updated_at
  ];
}

function scopeID(scope: AutomationScope): string {
  return scope.kind === "project" ? scope.project_id : scope.control_plane_id;
}

export function insertTrigger(db: RunnerDatabase, trigger: VersionedAutomationTrigger): void {
  db.sqlite.run(`insert into automation_trigger_configs
    (automation_id, version, trigger_type, config_json, created_by, created_at) values (?, ?, ?, ?, ?, ?)`, [
    trigger.automation_id, trigger.version, trigger.type, JSON.stringify(trigger.config), trigger.created_by, trigger.created_at
  ]);
}

export function assertTrigger(trigger: VersionedAutomationTrigger): void {
  const errors = validateVersionedAutomationTrigger(trigger);
  if (errors.length > 0) throw new Error(errors.join("; "));
}

export function assertAllowedAudit(audit: AutomationAudit): void {
  if (audit.gate.decision !== "allow" || !["deterministic_policy", "human_approval"].includes(audit.gate.authority)) {
    throw new Error("automation mutation requires an allowed deterministic policy or human approval gate");
  }
  if (!audit.event_id.trim() || !audit.actor_id.trim() || !audit.correlation_id.trim() || !audit.reason.trim() || !audit.gate.policy_ref.trim()) {
    throw new Error("automation audit identity, reason, correlation, and policy are required");
  }
  normalizeTimestamp(audit.occurred_at);
}

export function mapDefinition(row: Row): AutomationDefinition {
  return {
    active_trigger_version: number(row.active_trigger_version), created_at: text(row.created_at),
    id: text(row.id) as AutomationID, idempotency_namespace: text(row.idempotency_namespace), mode: text(row.mode) as AutomationDefinition["mode"],
    name: text(row.name), next_run_at: nullableText(row.next_run_at), owner: mapScope(text(row.scope_kind), text(row.scope_id)),
    permission_policy_ref: text(row.permission_policy_ref), revision: number(row.revision), status: text(row.status) as AutomationDefinition["status"],
    updated_at: text(row.updated_at), workflow_ref: text(row.workflow_ref)
  };
}

export function mapTrigger(row: Row): VersionedAutomationTrigger {
  const type = text(row.trigger_type) as AutomationTriggerConfig["type"];
  const base = { automation_id: text(row.automation_id) as AutomationID, created_at: text(row.created_at), created_by: text(row.created_by), version: number(row.version) };
  return { ...base, type, config: JSON.parse(text(row.config_json)) } as VersionedAutomationTrigger;
}

export function mapRun(row: Row): AutomationRun {
  return {
    automation_id: text(row.automation_id) as AutomationID, completed_at: nullableText(row.completed_at),
    created_at: text(row.created_at), idempotency_key: text(row.idempotency_key), requested_at: text(row.requested_at),
    run_id: text(row.run_id), status: text(row.status) as AutomationRunStatus, summary: JSON.parse(text(row.summary_json)), trigger_version: number(row.trigger_version)
  };
}

export function mapEvent(row: Row): AutomationEvent {
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

export function normalizeOptionalTimestamp(value: string | null | undefined): string | null { return value ? normalizeTimestamp(value) : null; }

function text(value: unknown): string { return typeof value === "string" ? value : ""; }

function nullableText(value: unknown): string | null { const result = text(value); return result ? result : null; }

function number(value: unknown): number { return typeof value === "number" ? value : Number(value); }

export function isRunStatus(value: string): value is AutomationRunStatus { return ["queued", "running", "succeeded", "failed", "skipped"].includes(value); }
