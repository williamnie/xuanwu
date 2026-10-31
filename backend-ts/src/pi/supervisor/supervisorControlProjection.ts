import { type PiAction } from "../../db/repositories/pi.ts";
import { WORK_WRITE_AUTHORITY } from "../../http/work/workApi.ts";
import { RUN_READ_AUTHORITY, RUN_WRITE_AUTHORITY } from "../../http/work/runApi.ts";
import { arrayValue, cleanString, numberValue, objectValue } from "../../util/values.ts";
import { DomainCall } from "./supervisorControlTools.ts";
import { withBudget, domainAuthority } from "./supervisorControlOutput.ts";
import { select, cleanObject, boundedText, jsonValue } from "./supervisorControlValidation.ts";

export function compactWorkList(call: DomainCall): Record<string, unknown> {
  if (!call.ok) return compactDomainError("work", call);
  const items = arrayValue(call.body.items).slice(0, 20).map((item) => compactWork(item, false));
  return withBudget("issues-via-work-adapter", {
    domain: "work",
    items,
    page: numberValue(call.body.page),
    total: numberValue(call.body.total),
    total_pages: numberValue(call.body.total_pages),
    truncated: numberValue(call.body.total) > items.length
  });
}

export function compactWorkDetail(call: DomainCall): Record<string, unknown> {
  if (!call.ok) return compactDomainError("work", call);
  return withBudget("issues-via-work-adapter", {
    domain: "work",
    work: compactWork(call.body.work, true)
  });
}

export function compactWorkMutation(call: DomainCall): Record<string, unknown> {
  if (!call.ok) return compactDomainError("work", call);
  const mutation = objectValue(call.body.mutation);
  return withBudget(WORK_WRITE_AUTHORITY, {
    domain: "work",
    mutation: select(mutation, ["applied", "audit_event_id"]),
    work: compactWork(call.body.work, true)
  });
}

export function compactWork(value: unknown, includeGoal: boolean): Record<string, unknown> {
  const work = objectValue(value);
  const owner = objectValue(work.owner);
  const acceptance = objectValue(work.acceptance);
  return cleanObject({
    acceptance: includeGoal ? {
      criteria_count: arrayValue(acceptance.criteria).length,
      version: numberValue(acceptance.version)
    } : undefined,
    goal: includeGoal ? boundedText(work.goal, 1200) : undefined,
    id: work.id,
    project_id: owner.project_id,
    revision: work.revision,
    status: work.status,
    title: boundedText(work.title, 240),
    type: work.type,
    updated_at: work.updated_at,
    workflow_ref: boundedText(work.workflow_ref, 240)
  });
}

export function compactRunList(call: DomainCall): Record<string, unknown> {
  if (!call.ok) return compactDomainError("run", call);
  const items = arrayValue(call.body.items).slice(0, 20).map(compactRun);
  return withBudget(RUN_READ_AUTHORITY, {
    domain: "run",
    items,
    page: numberValue(call.body.page),
    total: numberValue(call.body.total),
    total_pages: numberValue(call.body.total_pages),
    truncated: numberValue(call.body.total) > items.length
  });
}

export function compactRunDetail(call: DomainCall): Record<string, unknown> {
  if (!call.ok) return compactDomainError("run", call);
  const run = objectValue(call.body.run);
  return withBudget(RUN_READ_AUTHORITY, {
    domain: "run",
    run: {
      ...compactRun(run),
      attempts: arrayValue(run.attempts).slice(-12).map((item) => {
        const attempt = objectValue(item);
        const provider = objectValue(attempt.provider_ref);
        return cleanObject({
          id: attempt.id,
          kind: attempt.kind,
          mapping_errors: arrayValue(attempt.mapping_errors).slice(0, 4),
          provider: provider.provider,
          revision: attempt.revision,
          sequence: attempt.sequence,
          session_ref: provider.session_ref,
          started_at: attempt.started_at,
          status: attempt.status,
          turn_ref: provider.turn_ref,
          updated_at: attempt.updated_at
        });
      })
    }
  });
}

export function compactRunMutation(call: DomainCall): Record<string, unknown> {
  if (!call.ok) return compactDomainError("run", call);
  return withBudget(RUN_WRITE_AUTHORITY, {
    domain: "run",
    mutation: objectValue(call.body.mutation),
    run: compactRun(call.body.run)
  });
}

export function compactRun(value: unknown): Record<string, unknown> {
  const run = objectValue(value);
  const progress = objectValue(run.progress);
  return cleanObject({
    attempt_count: run.attempt_count,
    id: run.id,
    mapping_errors: arrayValue(run.mapping_errors).slice(0, 4),
    progress: select(progress, ["attempt_sequence", "attempt_status", "phase", "updated_at"]),
    project_id: run.project_id,
    provider: run.provider,
    revision: run.revision,
    sequence: run.sequence,
    status: run.status,
    trigger: run.trigger,
    updated_at: run.updated_at,
    work_id: run.work_id,
    work_title: boundedText(run.work_title, 240)
  });
}

export function compactDomainError(domain: string, call: DomainCall): Record<string, unknown> {
  return withBudget(domainAuthority(domain), {
    domain,
    error: cleanObject({
      code: cleanString(call.body.code) || "domain_request_failed",
      message: boundedText(call.body.message, 500),
      violations: arrayValue(call.body.violations).slice(0, 12).map((item) => boundedText(item, 240))
    }),
    http_status: call.status,
    ok: false
  });
}

export function compactActionRecord(action: PiAction): Record<string, unknown> {
  return withBudget(domainAuthority(action.action_type.split(".")[0] ?? ""), cleanObject({
    action_id: action.id,
    action_type: action.action_type,
    decision: action.gate_decision,
    gate_reason: action.gate_reason,
    idempotency_key: action.idempotency_key,
    issue_id: action.issue_id || undefined,
    project_id: action.project_id,
    requires_confirmation: action.requires_confirmation === 1,
    result: action.status === "completed" ? jsonValue(action.result_json) : undefined,
    risk_level: action.risk_level,
    status: action.status
  }));
}
