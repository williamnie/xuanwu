import type { RunnerDatabase } from "../../db/database.ts";
import type { Project } from "../../db/repositories/projects.ts";
import { workIDToIssueID } from "../../domain/work/issueAdapter.ts";
import { type Router } from "../../http/router.ts";
import type { PiRunnerActionContext } from "../runnerTools/runnerActions.ts";
import { idempotencyKey, MutationActionType } from "./supervisorControlTools.ts";
import { mutationAction, callDomain } from "./supervisorControlDispatch.ts";
import { compactWorkMutation, compactRunMutation } from "./supervisorControlProjection.ts";
import { retryPreconditionFailure } from "./supervisorControlOutput.ts";
import { limit, requiredProjectID, projectID, domainAudit, targetProjectID, cleanObject, requireRunTarget, runProjectID, requiredString } from "./supervisorControlValidation.ts";

export type WorkListInput = { limit?: number; project_id?: string; query?: string; statuses?: string[] };

export type WorkReadInput = { work_id: string };

export type WorkCreateInput = {
  depends_on_issue_ids?: number[];
  goal: string; idempotency_key: string; project_id?: string; reason: string; status?: "triage" | "todo"; title: string;
};

export type WorkUpdateInput = {
  expected_revision: number; goal?: string; idempotency_key: string; reason: string; title?: string; work_id: string;
};

export type WorkControlInput = {
  action: "cancel" | "enqueue" | "retry"; expected_revision: number; idempotency_key: string; reason: string; work_id: string;
};

export type RunListInput = { limit?: number; project_id?: string; providers?: string[]; statuses?: string[]; work_id?: string };

export type RunReadInput = { run_id: string };

export type RunControlInput = {
  action: "interrupt" | "resume" | "retry"; expected_attempt_revision?: number; expected_revision: number;
  idempotency_key: string; prompt?: string; reason: string; run_id: string;
};

export function workCreateAction(
  db: RunnerDatabase,
  router: Router,
  context: PiRunnerActionContext,
  project: Project | undefined,
  input: WorkCreateInput
) {
  const targetProject = requiredProjectID(input.project_id, project);
  const payload = {
    ...(input.depends_on_issue_ids === undefined
      ? {}
      : { depends_on_issue_ids: input.depends_on_issue_ids }),
    goal: input.goal,
    project_id: targetProject,
    reason: input.reason,
    status: input.status ?? "triage",
    title: input.title
  };
  return mutationAction(db, context, {
    actionType: "work.create",
    idempotencyKey: input.idempotency_key,
    payload,
    projectID: targetProject,
    reason: input.reason,
    target: targetProject,
    execute: async (eventID) => compactWorkMutation(await callDomain(router, "/api/works", {
      audit: domainAudit(context, eventID, input.reason),
      ...(input.depends_on_issue_ids === undefined
        ? {}
        : { depends_on_issue_ids: input.depends_on_issue_ids }),
      goal: input.goal,
      project_id: targetProject,
      status: input.status ?? "triage",
      title: input.title,
      type: "engineering_task"
    }, "POST"))
  });
}

export function workUpdateAction(
  db: RunnerDatabase,
  router: Router,
  context: PiRunnerActionContext,
  project: Project | undefined,
  input: WorkUpdateInput
) {
  const targetProject = targetProjectID(db, input.work_id, project);
  const issueID = workIDToIssueID(input.work_id);
  const payload = cleanObject({
    expected_revision: input.expected_revision,
    goal: input.goal,
    reason: input.reason,
    title: input.title,
    work_id: input.work_id
  });
  return mutationAction(db, context, {
    actionType: "work.update",
    idempotencyKey: input.idempotency_key,
    issueID,
    payload,
    projectID: targetProject,
    reason: input.reason,
    target: input.work_id,
    execute: async (eventID) => compactWorkMutation(await callDomain(router, `/api/works/${encodeURIComponent(input.work_id)}`, {
      audit: domainAudit(context, eventID, input.reason),
      expected_revision: input.expected_revision,
      ...(input.goal !== undefined ? { goal: input.goal } : {}),
      ...(input.title !== undefined ? { title: input.title } : {})
    }, "PATCH"))
  });
}

export function workControlAction(
  db: RunnerDatabase,
  router: Router,
  context: PiRunnerActionContext,
  project: Project | undefined,
  input: WorkControlInput
) {
  const targetProject = targetProjectID(db, input.work_id, project);
  const issueID = workIDToIssueID(input.work_id);
  const actionType = `work.${input.action}` as MutationActionType;
  const preconditionFailure = retryPreconditionFailure(db, issueID, actionType);
  const payload = {
    action: input.action,
    expected_revision: input.expected_revision,
    reason: input.reason,
    work_id: input.work_id
  };
  return mutationAction(db, context, {
    actionType,
    idempotencyKey: input.idempotency_key,
    issueID,
    payload,
    projectID: targetProject,
    preconditionFailure,
    reason: input.reason,
    target: input.work_id,
    execute: async (eventID) => compactWorkMutation(await callDomain(
      router,
      `/api/works/${encodeURIComponent(input.work_id)}/actions/${input.action}`,
      { audit: domainAudit(context, eventID, input.reason), expected_revision: input.expected_revision },
      "POST"
    ))
  });
}

export function runControlAction(
  db: RunnerDatabase,
  router: Router,
  context: PiRunnerActionContext,
  project: Project | undefined,
  input: RunControlInput
) {
  const run = requireRunTarget(db, input.run_id);
  const targetProject = runProjectID(db, input.run_id, project);
  const issueID = workIDToIssueID(requiredString(run.work_id, "Run work_id"));
  const actionType = `run.${input.action}` as MutationActionType;
  const preconditionFailure = retryPreconditionFailure(db, issueID, actionType);
  const payload = cleanObject({
    action: input.action,
    expected_attempt_revision: input.expected_attempt_revision,
    expected_revision: input.expected_revision,
    prompt: input.prompt,
    reason: input.reason,
    run_id: input.run_id
  });
  return mutationAction(db, context, {
    actionType,
    idempotencyKey: input.idempotency_key,
    issueID,
    payload,
    projectID: targetProject,
    preconditionFailure,
    reason: input.reason,
    target: input.run_id,
    execute: async (eventID) => compactRunMutation(await callDomain(
      router,
      `/api/runs/${encodeURIComponent(input.run_id)}/actions/${input.action}`,
      cleanObject({
        audit: domainAudit(context, eventID, input.reason),
        expected_attempt_revision: input.expected_attempt_revision,
        expected_revision: input.expected_revision,
        prompt: input.prompt
      }),
      "POST"
    ))
  });
}
