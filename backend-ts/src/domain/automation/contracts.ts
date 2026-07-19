import { parseWorkflowManifestRef } from "../../workflows/manifest.ts";

export const AUTOMATION_TRIGGER_TYPES = ["cron", "manual", "webhook", "continuous"] as const;
export const AUTOMATION_STATUSES = ["draft", "active", "paused", "archived"] as const;
export const AUTOMATION_MODES = ["observe", "propose", "execute_allowed"] as const;
export const AUTOMATION_RUN_STATUSES = ["queued", "running", "succeeded", "failed", "skipped"] as const;

export type AutomationTriggerType = typeof AUTOMATION_TRIGGER_TYPES[number];
export type AutomationStatus = typeof AUTOMATION_STATUSES[number];
export type AutomationMode = typeof AUTOMATION_MODES[number];
export type AutomationRunStatus = typeof AUTOMATION_RUN_STATUSES[number];
export type AutomationID = `automation:${string}`;
export type AutomationScope =
  | { kind: "project"; project_id: string }
  | { control_plane_id: "local"; kind: "control_plane" };

export type CronTriggerConfig = { expression: string; timezone: string };
export type ManualTriggerConfig = { target_issue_id?: number };
export type WebhookTriggerConfig = { event_type: string; secret_ref?: string };
export type ContinuousTriggerConfig = { poll_interval_seconds: number };
export type AutomationTriggerConfig =
  | { config: CronTriggerConfig; type: "cron" }
  | { config: ManualTriggerConfig; type: "manual" }
  | { config: WebhookTriggerConfig; type: "webhook" }
  | { config: ContinuousTriggerConfig; type: "continuous" };

export type VersionedAutomationTrigger = AutomationTriggerConfig & {
  automation_id: AutomationID;
  created_at: string;
  created_by: string;
  version: number;
};

export type AutomationDefinition = {
  active_trigger_version: number;
  created_at: string;
  id: AutomationID;
  idempotency_namespace: string;
  mode: AutomationMode;
  name: string;
  next_run_at: string | null;
  owner: AutomationScope;
  permission_policy_ref: string;
  revision: number;
  status: AutomationStatus;
  updated_at: string;
  workflow_ref: string;
};

export type AutomationAudit = {
  actor_id: string;
  actor_kind: "user" | "supervisor" | "runner" | "guardian" | "automation" | "system";
  correlation_id: string;
  event_id: string;
  gate: { authority: "deterministic_policy" | "human_approval"; decision: "allow" | "deny" | "ask"; policy_ref: string };
  occurred_at: string;
  reason: string;
};

export type AutomationStatusCommand = { audit: AutomationAudit; expected_revision: number; status: AutomationStatus };
export type AutomationRun = {
  automation_id: AutomationID;
  completed_at: string | null;
  created_at: string;
  idempotency_key: string;
  requested_at: string;
  run_id: string;
  status: AutomationRunStatus;
  summary: Record<string, unknown>;
  trigger_version: number;
};

const STATUS_TRANSITIONS: Record<AutomationStatus, readonly AutomationStatus[]> = {
  draft: ["active", "archived"],
  active: ["paused", "archived"],
  paused: ["active", "archived"],
  archived: []
};

export function validateAutomationDefinition(definition: AutomationDefinition): string[] {
  const errors: string[] = [];
  if (!/^automation:[a-z][a-z0-9._-]{0,127}$/.test(definition.id)) errors.push("automation id is invalid");
  if (!definition.name.trim()) errors.push("automation name is required");
  if (!definition.idempotency_namespace.trim()) errors.push("idempotency_namespace is required");
  if (!definition.permission_policy_ref.trim()) errors.push("permission_policy_ref is required");
  if (!parseWorkflowManifestRef(definition.workflow_ref)) errors.push("workflow_ref must reference a versioned Workflow manifest");
  if (!AUTOMATION_STATUSES.includes(definition.status)) errors.push("automation status is invalid");
  if (!AUTOMATION_MODES.includes(definition.mode)) errors.push("automation mode is invalid");
  if (!Number.isSafeInteger(definition.revision) || definition.revision < 0) errors.push("revision must be non-negative");
  if (!Number.isSafeInteger(definition.active_trigger_version) || definition.active_trigger_version < 1) {
    errors.push("active_trigger_version must be positive");
  }
  errors.push(...validateScope(definition.owner));
  errors.push(...validateTimestamp(definition.created_at, "created_at"));
  errors.push(...validateTimestamp(definition.updated_at, "updated_at"));
  if (definition.next_run_at !== null) errors.push(...validateTimestamp(definition.next_run_at, "next_run_at"));
  return errors;
}

export function validateVersionedAutomationTrigger(trigger: VersionedAutomationTrigger): string[] {
  const errors: string[] = [];
  if (!/^automation:[a-z][a-z0-9._-]{0,127}$/.test(trigger.automation_id)) errors.push("automation_id is invalid");
  if (!Number.isSafeInteger(trigger.version) || trigger.version < 1) errors.push("trigger version must be positive");
  if (!trigger.created_by.trim()) errors.push("trigger created_by is required");
  errors.push(...validateTimestamp(trigger.created_at, "trigger created_at"));
  if (trigger.type === "cron") {
    if (!trigger.config.expression.trim()) errors.push("cron expression is required");
    if (!isTimeZone(trigger.config.timezone)) errors.push("cron timezone must be an IANA timezone");
  } else if (trigger.type === "webhook") {
    if (!trigger.config.event_type.trim()) errors.push("webhook event_type is required");
  } else if (trigger.type === "continuous") {
    if (!Number.isSafeInteger(trigger.config.poll_interval_seconds) || trigger.config.poll_interval_seconds < 1) {
      errors.push("continuous poll_interval_seconds must be positive");
    }
  } else if (trigger.type === "manual" && trigger.config.target_issue_id !== undefined) {
    if (!Number.isSafeInteger(trigger.config.target_issue_id) || trigger.config.target_issue_id < 1) {
      errors.push("manual target_issue_id must be a positive integer");
    }
  }
  return errors;
}

export function applyAutomationStatusCommand(
  current: AutomationDefinition,
  command: AutomationStatusCommand
): AutomationDefinition {
  assertAutomationDefinition(current);
  assertAudit(command.audit);
  if (command.expected_revision !== current.revision) throw new Error("automation revision conflict");
  if (!STATUS_TRANSITIONS[current.status].includes(command.status)) {
    throw new Error(`invalid automation status transition ${current.status} -> ${command.status}`);
  }
  if (command.audit.gate.decision !== "allow") throw new Error("automation status change requires an allow gate");
  if (command.audit.gate.authority !== "deterministic_policy" && command.audit.gate.authority !== "human_approval") {
    throw new Error("automation status change requires a deterministic policy or human approval gate");
  }
  return {
    ...current,
    revision: current.revision + 1,
    status: command.status,
    updated_at: normalizeTimestamp(command.audit.occurred_at)
  };
}

export function normalizeTimestamp(value: string): string {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new Error("timestamp must be ISO-8601");
  return new Date(ms).toISOString();
}

export function assertAutomationDefinition(definition: AutomationDefinition): void {
  const errors = validateAutomationDefinition(definition);
  if (errors.length > 0) throw new Error(errors.join("; "));
}

function validateScope(scope: AutomationScope): string[] {
  if (scope.kind === "project") return scope.project_id.trim() ? [] : ["project scope project_id is required"];
  return scope.kind === "control_plane" && scope.control_plane_id === "local"
    ? []
    : ["control plane scope must be local"];
}

function validateTimestamp(value: string, label: string): string[] {
  try { normalizeTimestamp(value); return []; } catch { return [`${label} must be ISO-8601`]; }
}

function assertAudit(audit: AutomationAudit): void {
  if (!audit.actor_id.trim() || !audit.correlation_id.trim() || !audit.event_id.trim() || !audit.reason.trim()) {
    throw new Error("automation audit identity, correlation, event, and reason are required");
  }
  if (!audit.gate.policy_ref.trim()) throw new Error("automation audit gate policy_ref is required");
  normalizeTimestamp(audit.occurred_at);
}

function isTimeZone(value: string): boolean {
  try { Intl.DateTimeFormat("en-US", { timeZone: value }).format(); return true; } catch { return false; }
}
