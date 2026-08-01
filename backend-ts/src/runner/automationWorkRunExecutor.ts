import { createHash } from "node:crypto";
import {
  createAutomationExecutionLink,
  getAutomationExecutionLink,
  type AutomationExecutionLink
} from "../db/repositories/automationExecutionLinks.ts";
import { recordIssueEvent } from "../db/repositories/issueEvents.ts";
import { createIssueRun, updateIssueRuntime } from "../db/repositories/issueRuns.ts";
import { makeDomainID, type RunID } from "../xuanwu/coreDomainContracts.ts";
import { createIssueBackedWork, getIssueAsWork } from "../domain/work/issueAdapter.ts";
import type { WorkLedgerEntry } from "../domain/work/contracts.ts";
import type { AutomationDefinition } from "../domain/automation/contracts.ts";
import type { AutomationExecutor } from "./automationScheduler.ts";
import type { WorkflowRegistry, WorkflowResolution } from "../workflows/registry.ts";
import { requestIssuePiAcceptance } from "./piAcceptanceRequest.ts";

export type AutomationWorkflowDispatchResult = {
  detail?: string;
  outcome: "succeeded" | "skipped";
};

export type AutomationWorkflowDispatcher = (input: {
  automation: AutomationDefinition;
  automation_run_id: string;
  automation_id: string;
  context?: Record<string, unknown>;
  run_id: RunID;
  work: WorkLedgerEntry;
  workflow: WorkflowResolution;
}) => Promise<AutomationWorkflowDispatchResult>;

export type AutomationExecutionPreparation = {
  context?: Record<string, unknown>;
  detail?: string;
  outcome?: "skipped";
};

export type AutomationExecutionPreparationInput = Parameters<AutomationExecutor>[0] & {
  existing_link: AutomationExecutionLink | null;
};

export type AutomationWorkRunExecutorOptions = {
  dispatch: AutomationWorkflowDispatcher;
  prepare?: (input: AutomationExecutionPreparationInput) => AutomationExecutionPreparation | Promise<AutomationExecutionPreparation>;
  workflow_registry: Pick<WorkflowRegistry, "resolve">;
};

/**
 * Native Automation remains the trigger/lease authority. This adapter only
 * materializes its source-linked Issue Work/Run. A terminal Automation result
 * is only a Run fact; PI remains the sole semantic Issue decision-maker.
 */
export function createAutomationWorkRunExecutor(options: AutomationWorkRunExecutorOptions): AutomationExecutor {
  return async (input) => {
    const { automation, database, now, run } = input;
    const projectID = automation.owner.kind === "project" ? automation.owner.project_id : "";
    if (projectID === "") throw new Error("automation Work/Run dispatch requires a project scope");
    const existingLink = getAutomationExecutionLink(database, run.run_id);
    const preparation = await options.prepare?.({ ...input, existing_link: existingLink }) ?? {};
    if (!existingLink && preparation.outcome === "skipped") {
      return { detail: preparation.detail, outcome: "skipped" };
    }
    const link = existingLink ?? ensureLink(
      database,
      automation.id,
      automation.name,
      automation.workflow_ref,
      run.run_id,
      projectID,
      now,
      input.trigger.type === "manual" ? input.trigger.config.target_issue_id : undefined
    );
    const work = getIssueAsWork(database, link.issue_id);
    if (!work) throw new Error(`automation execution Work ${link.work_id} is missing`);
    try {
      const resolved = options.workflow_registry.resolve(automation.workflow_ref, projectID);
      if (!resolved.ok) {
        throw new Error(`workflow dispatch blocked: ${resolved.diagnostics.map((item) => item.message).join("; ")}`);
      }
      const output = await options.dispatch({
        automation,
        automation_id: automation.id,
        automation_run_id: run.run_id,
        context: preparation.context,
        run_id: link.run_id as RunID,
        work,
        workflow: resolved.resolution
      });
      const detail = clean(output.detail) || `workflow ${automation.workflow_ref} ${output.outcome}`;
      persistOutcome(database, link, automation, run.run_id, run.attempt_count, now, output.outcome, detail, preparation.context);
      return { detail: `${detail}; work=${link.work_id}; run=${link.run_id}`, outcome: output.outcome };
    } catch (error) {
      const detail = safeError(error);
      persistOutcome(database, link, automation, run.run_id, run.attempt_count, now, "failed", detail, preparation.context);
      throw error;
    }
  };
}

function ensureLink(
  database: Parameters<AutomationExecutor>[0]["database"],
  automationID: string,
  automationName: string,
  workflowRef: string,
  automationRunID: string,
  projectID: string,
  now: Date,
  targetIssueID?: number
): AutomationExecutionLink {
  const existing = getAutomationExecutionLink(database, automationRunID);
  if (existing) return existing;
  const timestamp = now.toISOString();
  const correlationID = `automation-run:${automationRunID}`;
  const work = targetIssueID ? getIssueAsWork(database, targetIssueID) : createIssueBackedWork(database, {
    audit: {
      actor: { id: "automation-runner", kind: "automation" },
      correlation_id: correlationID,
      event_id: `automation-dispatch:${digest(automationRunID)}`,
      gate: { authority: "deterministic_policy", decision: "allow", policy_ref: "automation-work-dispatch:v1" },
      occurred_at: timestamp,
      reason: "materialize governed Automation execution"
    },
    goal: `Automation ${automationID} dispatched ${workflowRef} for run ${automationRunID}.`,
    project_id: projectID,
    source: {
      authority: "automation_definitions",
      external_id: `${automationID}/${automationRunID}`,
      kind: "automation_trigger",
      source_event_id: `automation_runs:${automationRunID}`
    },
    status: "in_progress",
    title: `Automation: ${automationName}`.slice(0, 50),
    type: "engineering_task"
  }).work;
  if (!work) throw new Error(`automation target issue ${targetIssueID} is unavailable`);
  const issueID = Number(work.id.slice("xw:work:issues:".length));
  const issueRun = createIssueRun(database, issueID);
  const runID = makeDomainID("run", "issue_runs", issueRun.id);
  updateIssueRuntime(database, issueID, {
    issue_run_id: issueRun.id,
    metadata: { automation_id: automationID, automation_run_id: automationRunID, workflow_ref: workflowRef },
    provider: "automation",
    selection_reason: "governed automation workflow dispatch"
  });
  return createAutomationExecutionLink(database, {
    automation_id: automationID,
    automation_run_id: automationRunID,
    created_at: timestamp,
    issue_id: issueID,
    run_id: runID,
    updated_at: timestamp,
    work_id: work.id,
    workflow_ref: workflowRef
  });
}

function persistOutcome(
  database: Parameters<AutomationExecutor>[0]["database"],
  link: AutomationExecutionLink,
  automation: AutomationDefinition,
  automationRunID: string,
  attempt: number,
  now: Date,
  outcome: "succeeded" | "skipped" | "failed",
  detail: string,
  context?: Record<string, unknown>
): void {
  const timestamp = now.toISOString();
  const runStatus = outcome === "succeeded" ? "succeeded" : "failed";
  database.sqlite.run(
    `update issue_runs set status=?, ended_at=case when ended_at='' then ? else ended_at end,
      exit_reason=case when exit_reason='' then ? else exit_reason end,
      error=case when error='' then ? else error end where id=?`,
    [runStatus, timestamp, `automation_${outcome}`, detail, issueRunStorageID(link.run_id)]
  );
  recordIssueEvent(database, link.issue_id, "issue.automation_outcome.v1", {
    attempt,
    automation_id: automation.id,
    automation_run_id: automationRunID,
    context: context ?? {},
    detail,
    issue_run_id: issueRunStorageID(link.run_id),
    outcome,
    workflow_ref: link.workflow_ref
  });
  requestIssuePiAcceptance(database, link.issue_id, {
    reason: `Automation Run terminal: ${outcome}: ${detail}`,
    source: "automation-work-run-executor"
  });
}

function issueRunStorageID(runID: string): string {
  return runID.startsWith("xw:run:issue_runs:") ? runID.slice("xw:run:issue_runs:".length) : runID;
}

function digest(value: string): string { return createHash("sha256").update(value).digest("hex").slice(0, 24); }
function clean(value: unknown): string { return typeof value === "string" ? value.trim() : ""; }
function safeError(error: unknown): string { return clean(error instanceof Error ? error.message : String(error)) || "automation workflow dispatch failed"; }
