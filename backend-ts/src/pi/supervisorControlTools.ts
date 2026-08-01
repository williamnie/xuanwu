import { Type, type Static, type TSchema } from "@earendil-works/pi-ai";
import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { formatModelVisibleToolOutput } from "../security/promptInjectionDefense.ts";
import type { RunnerDatabase } from "../db/database.ts";
import { getIssue, listIssueRuns } from "../db/repositories/issues.ts";
import { getPiActionByIdempotencyKey, type PiAction } from "../db/repositories/pi.ts";
import type { Project } from "../db/repositories/projects.ts";
import { workIDToIssueID } from "../domain/work/issueAdapter.ts";
import { WORK_STATUSES } from "../domain/work/contracts.ts";
import { RUN_STATUSES } from "../domain/run/contracts.ts";
import { registerWorkRoutes, WORK_WRITE_AUTHORITY } from "../http/workApi.ts";
import { registerRunRoutes, RUN_READ_AUTHORITY, RUN_WRITE_AUTHORITY } from "../http/runApi.ts";
import { createRouter, type Router } from "../http/router.ts";
import { executeSafePiAction } from "./actionEngine.ts";
import { createIssueCompletionProjection } from "./issueToolViews.ts";
import type { PiRunnerActionContext } from "./runnerActions.ts";
import { scopedRunnerChatActionContext } from "./runnerChatAuthorization.ts";
import {
  SUPERVISOR_CONTROL_MUTATION_ACTION_TYPES,
  SUPERVISOR_CONTROL_READ_ACTION_TYPES,
  SUPERVISOR_CONTROL_TOOL_NAMES,
  SUPERVISOR_CONTROL_VISIBLE_OUTPUT_MAX_CHARS,
  SUPERVISOR_CONTROL_VISIBLE_OUTPUT_MAX_TOKENS
} from "./supervisorControlContracts.ts";

export {
  SUPERVISOR_CONTROL_DANGEROUS_TOOL_NAMES,
  SUPERVISOR_CONTROL_HIGH_RISK_ACTION_TYPES,
  SUPERVISOR_CONTROL_MUTATION_ACTION_TYPES,
  SUPERVISOR_CONTROL_READ_ACTION_TYPES,
  SUPERVISOR_CONTROL_READ_TOOL_NAMES,
  SUPERVISOR_CONTROL_TOOL_NAMES,
  SUPERVISOR_CONTROL_VISIBLE_OUTPUT_MAX_CHARS,
  SUPERVISOR_CONTROL_VISIBLE_OUTPUT_MAX_TOKENS
} from "./supervisorControlContracts.ts";

type SupervisorControlToolName = typeof SUPERVISOR_CONTROL_TOOL_NAMES[number];
type ToolExecutor<TParams extends TSchema> = (params: Static<TParams>) => Promise<unknown> | unknown;
type DomainCall = { body: Record<string, unknown>; ok: boolean; status: number };
type MutationActionType = typeof SUPERVISOR_CONTROL_MUTATION_ACTION_TYPES[number];

const objectOptions = { additionalProperties: false };
const optionalString = Type.Optional(Type.String());
const requiredText = Type.String({ minLength: 1, maxLength: 4096, pattern: "\\S" });
const idempotencyKey = Type.String({ minLength: 1, maxLength: 256, pattern: "\\S" });
const nonNegativeRevision = Type.Integer({ minimum: 0 });
const boundedLimit = Type.Optional(Type.Integer({ minimum: 1, maximum: 20 }));
const workID = Type.String({ pattern: "^xw:work:issues:[1-9][0-9]*$" });
const runID = Type.String({ pattern: "^xw:run:issue_runs:.+$" });

export function createPiSupervisorControlTools(
  db: RunnerDatabase,
  project?: Project,
  context: Omit<PiRunnerActionContext, "project"> = {}
): ToolDefinition[] {
  const actions = createSupervisorControlActions(db, project, context);
  return [
    controlTool("work_list", "Work List",
      "List compact authoritative Work records with deterministic project/status filters.",
      Type.Object({
        limit: boundedLimit,
        project_id: optionalString,
        query: optionalString,
        statuses: Type.Optional(Type.Array(Type.Union(WORK_STATUSES.map((status) => Type.Literal(status)))))
      }, objectOptions), actions.workList),
    controlTool("work_read", "Work Read",
      "Read one authoritative Issue-backed Work with bounded relations and acceptance metadata.",
      Type.Object({ work_id: workID }, objectOptions), actions.workRead),
    controlTool("work_create", "Work Create",
      "Create one Issue-backed engineering Work through the audited Work API. Requires an explicit idempotency key.",
      Type.Object({
        depends_on_issue_ids: Type.Optional(Type.Array(Type.Integer({ minimum: 1 }))),
        goal: requiredText,
        idempotency_key: idempotencyKey,
        project_id: optionalString,
        reason: requiredText,
        status: Type.Optional(Type.Union([Type.Literal("triage"), Type.Literal("todo")])),
        title: requiredText
      }, objectOptions), actions.workCreate),
    controlTool("work_update", "Work Update",
      "Update Work title or goal through optimistic revision and deterministic authorization gates.",
      Type.Object({
        expected_revision: nonNegativeRevision,
        goal: optionalString,
        idempotency_key: idempotencyKey,
        reason: requiredText,
        title: optionalString,
        work_id: workID
      }, objectOptions), actions.workUpdate),
    controlTool("work_control", "Work Control",
      "Enqueue, retry, or cancel one Work through the audited Work action API; cancellation is destructive.",
      Type.Object({
        action: Type.Union([Type.Literal("enqueue"), Type.Literal("retry"), Type.Literal("cancel")]),
        expected_revision: nonNegativeRevision,
        idempotency_key: idempotencyKey,
        reason: requiredText,
        work_id: workID
      }, objectOptions), actions.workControl),
    controlTool("run_list", "Run List",
      "List compact authoritative Run projections with bounded filters.",
      Type.Object({
        limit: boundedLimit,
        project_id: optionalString,
        providers: Type.Optional(Type.Array(requiredText)),
        statuses: Type.Optional(Type.Array(Type.Union(RUN_STATUSES.map((status) => Type.Literal(status))))),
        work_id: Type.Optional(workID)
      }, objectOptions), actions.runList),
    controlTool("run_read", "Run Read",
      "Read one authoritative Run with compact ordered Attempt projections.",
      Type.Object({ run_id: runID }, objectOptions), actions.runRead),
    controlTool("run_control", "Run Control",
      "Interrupt, resume, or retry one Run through the audited Run command service and provider preconditions. Interrupt is Run-only: for an Issue-linked Run, read the terminal state and resolve the Issue before ending the turn.",
      Type.Object({
        action: Type.Union([Type.Literal("interrupt"), Type.Literal("resume"), Type.Literal("retry")]),
        expected_attempt_revision: Type.Optional(nonNegativeRevision),
        expected_revision: nonNegativeRevision,
        idempotency_key: idempotencyKey,
        prompt: optionalString,
        reason: requiredText,
        run_id: runID
      }, objectOptions), actions.runControl)
  ];
}

function createSupervisorControlActions(
  db: RunnerDatabase,
  project: Project | undefined,
  context: Omit<PiRunnerActionContext, "project">
) {
  const actionContext: PiRunnerActionContext = { ...context, project };
  const router = createDomainRouter(db, actionContext);
  return {
    workList: (input: WorkListInput) => readAction(db, actionContext, "work.list", projectID(input.project_id, project), input,
      async () => compactWorkList(await callDomain(router, queryPath("/api/works", {
        page_size: limit(input.limit),
        project_id: projectID(input.project_id, project),
        q: cleanString(input.query),
        status: input.statuses
      })))),
    workRead: (input: WorkReadInput) => readAction(db, actionContext, "work.read", targetProjectID(db, input.work_id, project), input,
      async () => compactWorkDetail(await callDomain(router, `/api/works/${encodeURIComponent(input.work_id)}`))),
    workCreate: (input: WorkCreateInput) => workCreateAction(db, router, actionContext, project, input),
    workUpdate: (input: WorkUpdateInput) => workUpdateAction(db, router, actionContext, project, input),
    workControl: (input: WorkControlInput) => workControlAction(db, router, actionContext, project, input),
    runList: (input: RunListInput) => readAction(db, actionContext, "run.list", projectID(input.project_id, project), input,
      async () => compactRunList(await callDomain(router, queryPath("/api/runs", {
        page_size: limit(input.limit),
        project_id: projectID(input.project_id, project),
        provider: input.providers,
        status: input.statuses,
        work_id: cleanString(input.work_id)
      })))),
    runRead: (input: RunReadInput) => readAction(db, actionContext, "run.read", runProjectID(db, input.run_id, project), input,
      async () => compactRunDetail(await callDomain(router, `/api/runs/${encodeURIComponent(input.run_id)}`))),
    runControl: (input: RunControlInput) => runControlAction(db, router, actionContext, project, input)
  };
}

type WorkListInput = { limit?: number; project_id?: string; query?: string; statuses?: string[] };
type WorkReadInput = { work_id: string };
type WorkCreateInput = {
  depends_on_issue_ids?: number[];
  goal: string; idempotency_key: string; project_id?: string; reason: string; status?: "triage" | "todo"; title: string;
};
type WorkUpdateInput = {
  expected_revision: number; goal?: string; idempotency_key: string; reason: string; title?: string; work_id: string;
};
type WorkControlInput = {
  action: "cancel" | "enqueue" | "retry"; expected_revision: number; idempotency_key: string; reason: string; work_id: string;
};
type RunListInput = { limit?: number; project_id?: string; providers?: string[]; statuses?: string[]; work_id?: string };
type RunReadInput = { run_id: string };
type RunControlInput = {
  action: "interrupt" | "resume" | "retry"; expected_attempt_revision?: number; expected_revision: number;
  idempotency_key: string; prompt?: string; reason: string; run_id: string;
};

function workCreateAction(
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

function workUpdateAction(
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

function workControlAction(
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

function runControlAction(
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

function readAction(
  db: RunnerDatabase,
  context: PiRunnerActionContext,
  actionType: typeof SUPERVISOR_CONTROL_READ_ACTION_TYPES[number],
  targetProjectID: string,
  payload: Record<string, unknown>,
  execute: () => Promise<unknown>
) {
  return executeSafePiAction(db, context, {
    actionType,
    payload: cleanObject(payload),
    projectID: targetProjectID,
    execute
  });
}

async function mutationAction(
  db: RunnerDatabase,
  context: PiRunnerActionContext,
  input: {
    actionType: MutationActionType;
    execute: (eventID: string) => Promise<unknown>;
    idempotencyKey: string;
    issueID?: number;
    payload: Record<string, unknown>;
    preconditionFailure?: string;
    projectID: string;
    reason: string;
    target: string;
  }
) {
  const key = scopedIdempotencyKey(input.actionType, input.projectID, input.target, input.idempotencyKey);
  assertIdempotencyCompatible(db, key, input.actionType, input.projectID, input.issueID ?? 0, input.payload);
  const actionContext = scopedRunnerChatActionContext(context, input.actionType, {
    issueID: input.issueID,
    projectID: input.projectID
  });
  await executeSafePiAction(db, actionContext, {
    actionType: input.actionType,
    idempotencyKey: key,
    issueID: input.issueID,
    payload: input.payload,
    projectID: input.projectID,
    rationale: input.reason,
    preconditionFailure: input.preconditionFailure,
    execute: () => input.execute(key)
  });
  const action = getPiActionByIdempotencyKey(db, key);
  if (!action) throw new Error("Supervisor control action missing after execution");
  return compactActionRecord(action);
}

function createDomainRouter(db: RunnerDatabase, context: PiRunnerActionContext): Router {
  const router = createRouter();
  const apiContext = {
    bus: context.bus,
    database: db,
    providers: context.providers
  };
  registerWorkRoutes(router, apiContext);
  registerRunRoutes(router, apiContext);
  return router;
}

async function callDomain(
  router: Router,
  path: string,
  body?: Record<string, unknown>,
  method: "GET" | "PATCH" | "POST" = "GET"
): Promise<DomainCall> {
  const response = await router.handle(new Request(`http://supervisor.internal${path}`, {
    ...(body ? { body: JSON.stringify(body) } : {}),
    headers: body ? { "content-type": "application/json" } : undefined,
    method
  }));
  const parsed = await response.json().catch(() => ({ code: "invalid_domain_response", message: "Domain API returned non-JSON" }));
  const output = isRecord(parsed) ? parsed : { value: parsed };
  if (response.status >= 500) {
    throw new Error(requiredString(output.message, "Domain API failure"));
  }
  return { body: output, ok: response.ok, status: response.status };
}

function compactWorkList(call: DomainCall): Record<string, unknown> {
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

function compactWorkDetail(call: DomainCall): Record<string, unknown> {
  if (!call.ok) return compactDomainError("work", call);
  return withBudget("issues-via-work-adapter", {
    domain: "work",
    work: compactWork(call.body.work, true)
  });
}

function compactWorkMutation(call: DomainCall): Record<string, unknown> {
  if (!call.ok) return compactDomainError("work", call);
  const mutation = objectValue(call.body.mutation);
  return withBudget(WORK_WRITE_AUTHORITY, {
    domain: "work",
    mutation: select(mutation, ["applied", "audit_event_id"]),
    work: compactWork(call.body.work, true)
  });
}

function compactWork(value: unknown, includeGoal: boolean): Record<string, unknown> {
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

function compactRunList(call: DomainCall): Record<string, unknown> {
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

function compactRunDetail(call: DomainCall): Record<string, unknown> {
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

function compactRunMutation(call: DomainCall): Record<string, unknown> {
  if (!call.ok) return compactDomainError("run", call);
  return withBudget(RUN_WRITE_AUTHORITY, {
    domain: "run",
    mutation: objectValue(call.body.mutation),
    run: compactRun(call.body.run)
  });
}

function compactRun(value: unknown): Record<string, unknown> {
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

function compactDomainError(domain: string, call: DomainCall): Record<string, unknown> {
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

function compactActionRecord(action: PiAction): Record<string, unknown> {
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

function retryPreconditionFailure(
  db: RunnerDatabase,
  issueID: number,
  actionType: MutationActionType
): string | undefined {
  if (actionType !== "work.retry" && actionType !== "run.retry") return undefined;
  const issue = getIssue(db, issueID);
  if (!issue) return undefined;
  const completion = createIssueCompletionProjection(db, issue, listIssueRuns(db, issue.id).at(-1));
  return completion.state === "acceptance_pending"
    ? "the Run is terminal and PI semantic acceptance is pending; do not retry the executor"
    : undefined;
}

function withBudget(authority: string, value: Record<string, unknown>): Record<string, unknown> {
  const output = {
    authority,
    observed_at: new Date().toISOString(),
    output_budget: {
      max_chars: SUPERVISOR_CONTROL_VISIBLE_OUTPUT_MAX_CHARS,
      max_tokens_estimate: SUPERVISOR_CONTROL_VISIBLE_OUTPUT_MAX_TOKENS
    },
    ...value
  };
  const serialized = JSON.stringify(output);
  if (serialized.length <= SUPERVISOR_CONTROL_VISIBLE_OUTPUT_MAX_CHARS) return output;
  let preview = serialized.slice(0, SUPERVISOR_CONTROL_VISIBLE_OUTPUT_MAX_CHARS - 1000);
  let bounded = truncatedProjection(authority, serialized.length, preview);
  while (JSON.stringify(bounded).length > SUPERVISOR_CONTROL_VISIBLE_OUTPUT_MAX_CHARS && preview.length > 0) {
    preview = preview.slice(0, Math.max(0, preview.length - 256));
    bounded = truncatedProjection(authority, serialized.length, preview);
  }
  return bounded;
}

function truncatedProjection(authority: string, originalChars: number, preview: string): Record<string, unknown> {
  return {
    authority,
    observed_at: new Date().toISOString(),
    original_chars: originalChars,
    output_budget: {
      max_chars: SUPERVISOR_CONTROL_VISIBLE_OUTPUT_MAX_CHARS,
      max_tokens_estimate: SUPERVISOR_CONTROL_VISIBLE_OUTPUT_MAX_TOKENS
    },
    preview,
    truncated: true
  };
}

function domainAuthority(domain: string): string {
  if (domain === "work") return WORK_WRITE_AUTHORITY;
  if (domain === "run") return RUN_WRITE_AUTHORITY;
  return "unknown";
}

function controlTool<TParams extends TSchema>(
  name: SupervisorControlToolName,
  label: string,
  description: string,
  parameters: TParams,
  executeAction: ToolExecutor<TParams>
): ToolDefinition<TParams> {
  return {
    name,
    label,
    description,
    parameters,
    async execute(_toolCallID, params) {
      const details = await executeAction(params);
      return toolResult(details);
    }
  };
}

function toolResult(details: unknown): AgentToolResult<unknown> {
  return {
    content: [{
      type: "text",
      text: formatModelVisibleToolOutput(details, { maxChars: SUPERVISOR_CONTROL_VISIBLE_OUTPUT_MAX_CHARS })
    }],
    details
  };
}

function domainAudit(context: PiRunnerActionContext, eventID: string, reason: string) {
  return {
    actor: {
      id: cleanString(context.conversationID) || cleanString(context.delegationID) || "xuanwu-supervisor",
      kind: "supervisor"
    },
    correlation_id: cleanString(context.conversationID) || cleanString(context.heartbeatID) || eventID,
    event_id: eventID,
    occurred_at: new Date().toISOString(),
    reason
  };
}

function scopedIdempotencyKey(actionType: string, projectIDValue: string, target: string, value: string): string {
  return ["supervisor-control", actionType, projectIDValue || "global", target, requiredString(value, "idempotency_key")].join(":");
}

function assertIdempotencyCompatible(
  db: RunnerDatabase,
  key: string,
  actionType: string,
  projectIDValue: string,
  issueID: number,
  payload: Record<string, unknown>
): void {
  const existing = getPiActionByIdempotencyKey(db, key);
  if (!existing) return;
  const matches = existing.action_type === actionType && existing.project_id === projectIDValue &&
    existing.issue_id === issueID && stableJson(jsonValue(existing.payload_json)) === stableJson(payload);
  if (!matches) throw new Error("idempotency_key conflicts with another Supervisor control command");
}

function targetProjectID(db: RunnerDatabase, workIDValue: string, fallback?: Project): string {
  const issueID = workIDToIssueID(workIDValue);
  const row = db.sqlite.query<{ project_id: string }, [number]>("select project_id from issues where id=?").get(issueID);
  return row?.project_id ?? fallback?.id ?? "";
}

function runProjectID(db: RunnerDatabase, runIDValue: string, fallback?: Project): string {
  const run = requireRunTarget(db, runIDValue);
  return cleanString(run.project_id) || fallback?.id || "";
}

function requireRunTarget(db: RunnerDatabase, runIDValue: string): Record<string, unknown> {
  const row = db.sqlite.query<Record<string, unknown>, [string]>(`
    select issue.project_id, run.work_id from issue_runs run
    join issues issue on issue.id=run.issue_id where run.run_id=?
  `).get(runIDValue);
  if (!row) throw new Error("Run not found");
  return row;
}

function projectID(value: unknown, fallback?: Project): string {
  return cleanString(value) || fallback?.id || "";
}

function requiredProjectID(value: unknown, fallback?: Project): string {
  const id = projectID(value, fallback);
  if (id === "") throw new Error("project_id is required");
  return id;
}

function queryPath(path: string, input: Record<string, unknown>): string {
  const params = new URLSearchParams();
  for (const [key, raw] of Object.entries(input)) {
    for (const value of Array.isArray(raw) ? raw : [raw]) {
      if (value === undefined || value === null) continue;
      if (typeof value === "string" && value.trim() === "") continue;
      params.append(key, String(value));
    }
  }
  const query = params.toString();
  return query === "" ? path : `${path}?${query}`;
}

function limit(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? Math.min(value, 20) : 10;
}


function boundedText(value: unknown, max: number): string {
  const text = cleanString(value);
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

function select(value: unknown, keys: string[]): Record<string, unknown> {
  const record = objectValue(value);
  return cleanObject(Object.fromEntries(keys.map((key) => [key, record[key]])));
}

function cleanObject(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== ""));
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function objectValue(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function booleanValue(value: unknown): boolean {
  return value === true || value === 1;
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function requiredString(value: unknown, label: string): string {
  const text = cleanString(value);
  if (text === "") throw new Error(`${label} is required`);
  return text;
}

function jsonValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}
