import type { RunnerDatabase } from "../db/database.ts";
import { createAutomation } from "../db/repositories/automations.ts";
import { getIssue, type Issue } from "../db/repositories/issues.ts";
import { ProjectNotFoundError } from "../db/repositories/projects.ts";
import { createPendingPiAction, type PiActionContext } from "./actionEngine.ts";
import { scopedRunnerChatActionContext } from "./runnerChatAuthorization.ts";
import { IMPLEMENT_WORKFLOW_REF } from "../workflows/implement.ts";

export type IssueScheduleEnqueueInput = {
  issue_id: number;
  name?: string;
  next_run_at: string;
  rationale?: string;
  timezone?: string;
};

type IssueScheduleContext = PiActionContext;

export function createIssueScheduleEnqueueAction(
  db: RunnerDatabase,
  context: IssueScheduleContext,
  input: IssueScheduleEnqueueInput
): unknown {
  const issue = mustGetIssue(db, input.issue_id);
  const payload = schedulePayload(issue, input);
  const actionContext = scopedRunnerChatActionContext(context, "issue.schedule_enqueue", {
    issueID: issue.id,
    projectID: issue.project_id
  });
  return createPendingPiAction(db, actionContext, {
    actionType: "issue.schedule_enqueue",
    issueID: issue.id,
    payload,
    projectID: issue.project_id,
    rationale: input.rationale
  }, () => createIssueEnqueueCron(db, payload));
}

export function createIssueEnqueueCron(
  db: RunnerDatabase,
  payload: Record<string, unknown>
): ScheduledIssueEnqueueResult {
  const issue = mustGetIssue(db, positiveID(payload.issue_id, "issue_id"));
  const now = new Date().toISOString();
  const id = `automation:issue-${issue.id}-${crypto.randomUUID()}` as const;
  const automation = createAutomation(db, {
    id,
    idempotency_namespace: `issue.schedule_enqueue:${issue.id}:${id}`,
    mode: "execute_allowed",
    name: automationName(issue, payload.name),
    next_run_at: requiredString(payload.next_run_at, "next_run_at"),
    owner: { kind: "project", project_id: issue.project_id },
    permission_policy_ref: `project-policy:${issue.project_id}`,
    status: "active",
    trigger: { type: "manual", config: { target_issue_id: issue.id } },
    trigger_created_by: "pi-action-dispatch",
    workflow_ref: IMPLEMENT_WORKFLOW_REF
  }, now, {
    actor_id: "pi-action-dispatch",
    actor_kind: "supervisor",
    correlation_id: `issue.schedule_enqueue:${issue.id}`,
    event_id: `automation-event:issue-schedule:${crypto.randomUUID()}`,
    gate: { authority: "deterministic_policy", decision: "allow", policy_ref: "pi-action-approved-schedule:v1" },
    occurred_at: now,
    reason: `approved issue.schedule_enqueue for issue ${issue.id}`
  });
  return scheduledResult(issue, automation);
}

type ScheduledIssueEnqueueResult = {
  automation_id: string;
  issue_id: number;
  next_run_at: string;
  status: string;
  type: "issue.schedule_enqueue";
};

function schedulePayload(
  issue: Issue,
  input: IssueScheduleEnqueueInput
): Record<string, unknown> {
  return cleanObject({
    issue_id: issue.id,
    name: input.name,
    next_run_at: input.next_run_at,
    timezone: input.timezone
  });
}

function scheduledResult(
  issue: Issue,
  automation: ReturnType<typeof createAutomation>
): ScheduledIssueEnqueueResult {
  return {
    automation_id: automation.id,
    issue_id: issue.id,
    next_run_at: automation.next_run_at || "",
    status: automation.status,
    type: "issue.schedule_enqueue"
  };
}

function automationName(issue: Issue, name: unknown): string {
  return cleanString(name) || `定时执行 issue #${issue.id} - ${issue.title}`;
}

function mustGetIssue(db: RunnerDatabase, id: number): Issue {
  const issue = getIssue(db, id);
  if (!issue) throw new ProjectNotFoundError();
  return issue;
}

function positiveID(value: unknown, label: string): number {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
  throw new Error(`${label} is required`);
}

function requiredString(value: unknown, label: string): string {
  const text = cleanString(value);
  if (text === "") throw new Error(`${label} is required`);
  return text;
}

function cleanObject(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined && value !== ""));
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
