import { getProject } from "../../db/repositories/projects.ts";
import { getAgentProfile } from "../../db/repositories/agentProfiles.ts";
import { isExecutorProviderId } from "../../providers/types.ts";
import { type IssueWorkAction, type IssueWorkMutationResult } from "../../domain/work/issueAdapter.ts";
import { type WorkLedgerEntry, type WorkTransitionAudit } from "../../domain/work/contracts.ts";
import { READINESS_STAGES, type ReadinessRequirement, type ReadinessRequirementDeclaration } from "../../domain/readiness/contracts.ts";
import { startProjectLoop } from "../../runner/projectLoopManager.ts";
import { json } from "../errors.ts";
import type { ReadApiContext } from "../readApiContext.ts";
import { cleanString } from "../../util/values.ts";
import { providersForProjectCwd } from "../../nodes/remoteExecution.ts";
import { isRemoteProjectCwd } from "../../nodes/projectLocation.ts";
import { workError, WORK_HTTP_POLICY_REF } from "./workApi.decodeWorkCursor.ts";
import { assertKeys, canonicalWorkID, pathParts } from "./workApi.listResponse.ts";

export function validateWorkExecutionSelection(
  context: ReadApiContext,
  project: NonNullable<ReturnType<typeof getProject>>,
  explicitProfileID: string
): void {
  const effectiveProfileID = explicitProfileID || project.default_agent_profile_id;
  const profile = effectiveProfileID ? getAgentProfile(context.database, effectiveProfileID) : null;
  if (effectiveProfileID && !profile) {
    throw workError(400, "invalid_agent_profile", `Agent Profile "${effectiveProfileID}" was not found`);
  }
  const providerID = profile?.provider || project.provider;
  if (!isExecutorProviderId(providerID)) {
    throw workError(409, "provider_unavailable", `provider "${providerID}" is not registered`);
  }
  if (!context.providers) return;
  const provider = providersForProjectCwd(context.providers, project.cwd)[providerID];
  if (!provider || !provider.capabilities.includes("issue_execution")) {
    throw workError(409, "provider_unavailable", `provider "${providerID}" does not support issue_execution`);
  }
  const status = provider.runtimeStatus?.();
  // 远程节点离线时允许先建任务，节点上线后再执行。
  if (status?.ready === false && !isRemoteProjectCwd(project.cwd)) {
    throw workError(409, "provider_not_ready", `provider "${providerID}" is not ready: ${status.reason || "configuration required"}`);
  }
}

export function readinessDeclaration(
  body: Record<string, unknown>,
  work: WorkLedgerEntry
): ReadinessRequirementDeclaration {
  if (body.schema_version !== 1) throw workError(400, "invalid_request", "schema_version must be 1");
  const declaredWorkID = requiredString(body.work_id, "work_id");
  if (declaredWorkID !== work.id) throw workError(400, "invalid_request", "work_id must match the route Work");
  if (!Array.isArray(body.requirements) || body.requirements.length === 0) {
    throw workError(400, "invalid_request", "requirements are required");
  }
  return {
    audit: readinessAudit(body.audit),
    requirements: body.requirements.map((value, index) => readinessRequirement(value, index)),
    schema_version: 1,
    work_id: work.id
  };
}

export function readinessAudit(value: unknown): ReadinessRequirementDeclaration["audit"] {
  const audit = auditInput(value);
  return {
    actor: audit.actor,
    correlation_id: audit.correlation_id,
    event_id: audit.event_id,
    occurred_at: audit.occurred_at,
    reason: audit.reason
  };
}

export function readinessRequirement(value: unknown, index: number): ReadinessRequirement {
  const item = objectValue(value, `requirements[${index}]`);
  assertKeys(item, [
    "environment", "migration_gate", "release_window", "required_stage",
    "runtime_revision", "source_revision", "source_work_id"
  ]);
  const stage = requiredString(item.required_stage, `requirements[${index}].required_stage`);
  if (!READINESS_STAGES.includes(stage as typeof READINESS_STAGES[number])) {
    throw workError(400, "invalid_request", `requirements[${index}].required_stage is invalid`);
  }
  return {
    environment: requiredString(item.environment, `requirements[${index}].environment`),
    ...(cleanString(item.migration_gate) ? { migration_gate: cleanString(item.migration_gate) } : {}),
    release_window: requiredString(item.release_window, `requirements[${index}].release_window`),
    required_stage: stage as ReadinessRequirement["required_stage"],
    runtime_revision: requiredString(item.runtime_revision, `requirements[${index}].runtime_revision`),
    source_revision: requiredString(item.source_revision, `requirements[${index}].source_revision`),
    source_work_id: canonicalWorkID(requiredString(item.source_work_id, `requirements[${index}].source_work_id`))
  };
}

export function mutationResponse(result: IssueWorkMutationResult, appliedStatus = 200): Response {
  if (!result.applied) {
    return json({
      code: "work_mutation_rejected",
      message: "Work mutation rejected",
      violations: result.violations,
      work: result.work
    }, { status: 409 });
  }
  return json({
    mutation: {
      applied: true,
      audit_event_id: result.audit_event_id
    },
    work: result.work
  }, { status: appliedStatus });
}

export function auditInput(value: unknown): WorkTransitionAudit {
  const audit = objectValue(value, "audit");
  assertKeys(audit, ["actor", "correlation_id", "event_id", "occurred_at", "reason"]);
  const actor = objectValue(audit.actor, "audit.actor");
  assertKeys(actor, ["id", "kind"]);
  const kind = requiredString(actor.kind, "audit.actor.kind");
  if (!["user", "supervisor", "runner", "guardian", "automation", "system"].includes(kind)) {
    throw workError(400, "invalid_request", "audit.actor.kind is invalid");
  }
  const occurredAt = requiredString(audit.occurred_at, "audit.occurred_at");
  if (!Number.isFinite(Date.parse(occurredAt))) {
    throw workError(400, "invalid_request", "audit.occurred_at must be a timestamp");
  }
  return {
    actor: { id: requiredString(actor.id, "audit.actor.id"), kind: kind as WorkTransitionAudit["actor"]["kind"] },
    correlation_id: requiredString(audit.correlation_id, "audit.correlation_id"),
    event_id: requiredString(audit.event_id, "audit.event_id"),
    gate: { authority: "deterministic_policy", decision: "allow", policy_ref: WORK_HTTP_POLICY_REF },
    occurred_at: occurredAt,
    reason: requiredString(audit.reason, "audit.reason")
  };
}

export function actionInput(request: Request): IssueWorkAction {
  const parts = pathParts(request);
  const action = decodeURIComponent(parts[parts.indexOf("actions") + 1] ?? "").trim();
  if (action !== "cancel" && action !== "enqueue" && action !== "retry") {
    throw workError(400, "invalid_request", "Work action must be cancel, enqueue, or retry");
  }
  return action;
}

export function kickProject(context: ReadApiContext, work: WorkLedgerEntry): void {
  if (work.status !== "todo" && work.status !== "cancelled") return;
  const project = getProject(context.database, work.owner.project_id);
  if (!project || project.auto_run !== 1) return;
  startProjectLoop({ bus: context.bus, database: context.database, providers: context.providers }, project.id);
}

export function revisionInput(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw workError(400, "invalid_request", "expected_revision must be a non-negative integer");
  }
  return value;
}

export function objectValue(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw workError(400, "invalid_request", `${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function requiredString(value: unknown, field: string): string {
  const text = cleanString(value);
  if (text === "") throw workError(400, "invalid_request", `${field} is required`);
  return text;
}

export function positiveIssueIDArray(value: unknown): number[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) =>
    typeof item !== "number" || !Number.isSafeInteger(item) || item <= 0
  )) {
    throw workError(400, "invalid_request", "depends_on_issue_ids must be a positive integer array");
  }
  const ids = [...value as number[]];
  const duplicate = ids.find((id, index) => ids.indexOf(id) !== index);
  if (duplicate !== undefined) {
    throw workError(400, "invalid_request", `depends_on_issue_ids cannot repeat Issue #${duplicate}`);
  }
  return ids.sort((left, right) => left - right);
}
