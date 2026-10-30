import { Type, type Static, type TSchema } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { RunnerDatabase } from "../../db/database.ts";
import type { Project } from "../../db/repositories/projects.ts";
import { WORK_STATUSES } from "../../domain/work/contracts.ts";
import { RUN_STATUSES } from "../../domain/run/contracts.ts";
import type { PiRunnerActionContext } from "../runnerTools/runnerActions.ts";
import { SUPERVISOR_CONTROL_MUTATION_ACTION_TYPES, SUPERVISOR_CONTROL_TOOL_NAMES, SUPERVISOR_CONTROL_VISIBLE_OUTPUT_MAX_CHARS, SUPERVISOR_CONTROL_VISIBLE_OUTPUT_MAX_TOKENS } from "./supervisorControlContracts.ts";
import { cleanString } from "../../util/values.ts";
import { WorkListInput, WorkReadInput, WorkCreateInput, workCreateAction, WorkUpdateInput, workUpdateAction, WorkControlInput, workControlAction, RunListInput, RunReadInput, RunControlInput, runControlAction } from "./supervisorControlActions.ts";
import { createDomainRouter, readAction, callDomain } from "./supervisorControlDispatch.ts";
import { compactWorkList, compactWorkDetail, compactRunList, compactRunDetail } from "./supervisorControlProjection.ts";
import { controlTool } from "./supervisorControlOutput.ts";
import { limit, projectID, queryPath, targetProjectID, runProjectID } from "./supervisorControlValidation.ts";

export type SupervisorControlToolName = typeof SUPERVISOR_CONTROL_TOOL_NAMES[number];

export type ToolExecutor<TParams extends TSchema> = (params: Static<TParams>) => Promise<unknown> | unknown;

export type DomainCall = { body: Record<string, unknown>; ok: boolean; status: number };

export type MutationActionType = typeof SUPERVISOR_CONTROL_MUTATION_ACTION_TYPES[number];

export const objectOptions = { additionalProperties: false };

export const optionalString = Type.Optional(Type.String());

export const requiredText = Type.String({ minLength: 1, maxLength: 4096, pattern: "\\S" });

export const idempotencyKey = Type.String({ minLength: 1, maxLength: 256, pattern: "\\S" });

export const nonNegativeRevision = Type.Integer({ minimum: 0 });

export const boundedLimit = Type.Optional(Type.Integer({ minimum: 1, maximum: 20 }));

export const workID = Type.String({ pattern: "^xw:work:issues:[1-9][0-9]*$" });

export const runID = Type.String({ pattern: "^xw:run:issue_runs:.+$" });

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

export function createSupervisorControlActions(
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
export { SUPERVISOR_CONTROL_DANGEROUS_TOOL_NAMES, SUPERVISOR_CONTROL_HIGH_RISK_ACTION_TYPES, SUPERVISOR_CONTROL_READ_TOOL_NAMES, SUPERVISOR_CONTROL_TOOL_NAMES, SUPERVISOR_CONTROL_VISIBLE_OUTPUT_MAX_CHARS, SUPERVISOR_CONTROL_VISIBLE_OUTPUT_MAX_TOKENS } from "./supervisorControlContracts.ts";
