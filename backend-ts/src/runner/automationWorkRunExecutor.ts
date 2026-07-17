import { createHash } from "node:crypto";
import {
  createAutomationExecutionLink,
  getAutomationExecutionLink,
  type AutomationExecutionLink
} from "../db/repositories/automationExecutionLinks.ts";
import { recordEvidenceRecords } from "../db/repositories/evidence.ts";
import { recordHandoff } from "../db/repositories/handoffs.ts";
import { createIssueRun, updateIssueRuntime } from "../db/repositories/issueRuns.ts";
import { updateIssue } from "../db/repositories/issueUpdate.ts";
import { makeDomainID, type EvidenceID, type HandoffID, type RunID } from "../xuanwu/coreDomainContracts.ts";
import { createIssueBackedWork, getIssueAsWork } from "../domain/work/issueAdapter.ts";
import type { WorkLedgerEntry } from "../domain/work/contracts.ts";
import type { EvidenceRecord } from "../domain/evidence/contracts.ts";
import type { HandoffRecord } from "../domain/handoff/contracts.ts";
import type { AutomationDefinition } from "../domain/automation/contracts.ts";
import type { AutomationExecutor } from "./automationScheduler.ts";
import type { WorkflowRegistry, WorkflowResolution } from "../workflows/registry.ts";

export type AutomationWorkflowDispatchResult = {
  detail?: string;
  outcome: "succeeded" | "skipped";
};

export type AutomationWorkflowDispatcher = (input: {
  automation: AutomationDefinition;
  automation_run_id: string;
  automation_id: string;
  run_id: RunID;
  work: WorkLedgerEntry;
  workflow: WorkflowResolution;
}) => Promise<AutomationWorkflowDispatchResult>;

export type AutomationWorkRunExecutorOptions = {
  dispatch: AutomationWorkflowDispatcher;
  workflow_registry: Pick<WorkflowRegistry, "resolve">;
};

/**
 * Native Automation remains the trigger/lease authority. This adapter only
 * materializes its source-linked Issue Work/Run and records its terminal
 * deterministic observation as Evidence plus a reviewable Handoff.
 */
export function createAutomationWorkRunExecutor(options: AutomationWorkRunExecutorOptions): AutomationExecutor {
  return async ({ automation, database, now, run }) => {
    const projectID = automation.owner.kind === "project" ? automation.owner.project_id : "";
    if (projectID === "") throw new Error("automation Work/Run dispatch requires a project scope");
    const link = ensureLink(database, automation.id, automation.name, automation.workflow_ref, run.run_id, projectID, now);
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
        run_id: link.run_id as RunID,
        work,
        workflow: resolved.resolution
      });
      const detail = clean(output.detail) || `workflow ${automation.workflow_ref} ${output.outcome}`;
      persistOutcome(database, link, automation, run.run_id, run.attempt_count, now, output.outcome, detail);
      return { detail: `${detail}; work=${link.work_id}; run=${link.run_id}`, outcome: output.outcome };
    } catch (error) {
      const detail = safeError(error);
      persistOutcome(database, link, automation, run.run_id, run.attempt_count, now, "failed", detail);
      if (run.attempt_count >= run.max_attempts) {
        updateIssue(database, link.issue_id, { error: detail, status: "failed" });
      }
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
  now: Date
): AutomationExecutionLink {
  const existing = getAutomationExecutionLink(database, automationRunID);
  if (existing) return existing;
  const timestamp = now.toISOString();
  const correlationID = `automation-run:${automationRunID}`;
  const work = createIssueBackedWork(database, {
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
  detail: string
): void {
  const timestamp = now.toISOString();
  const evidence = outcomeEvidence(link, automation, automationRunID, attempt, timestamp, outcome, detail);
  recordEvidenceRecords(database, link.issue_id, [evidence], { recorded_at: timestamp, source: "automation-work-run-executor" });
  const handoff = outcomeHandoff(link, automationRunID, attempt, timestamp, evidence, outcome, detail);
  recordHandoff(database, link.issue_id, handoff, { recorded_at: timestamp, source: "automation-work-run-executor" });
  if (outcome === "succeeded") updateIssue(database, link.issue_id, { status: "pending_verification" });
  if (outcome === "skipped") updateIssue(database, link.issue_id, { error: detail, status: "cancelled" });
}

function outcomeEvidence(
  link: AutomationExecutionLink,
  automation: AutomationDefinition,
  automationRunID: string,
  attempt: number,
  timestamp: string,
  outcome: "succeeded" | "skipped" | "failed",
  detail: string
): EvidenceRecord {
  const status = outcome === "succeeded" ? "passed" : outcome === "skipped" ? "blocked" : "failed";
  return {
    schema_version: 1,
    id: makeDomainID("evidence", "issue_events", `automation-${automationRunID}-${attempt}`) as EvidenceID,
    work_id: link.work_id as EvidenceRecord["work_id"],
    run_id: link.run_id as RunID,
    revision: 0,
    kind: "automation_execution",
    status,
    created_at: timestamp,
    observed_at: timestamp,
    updated_at: timestamp,
    completed_at: timestamp,
    decisive_output: {
      summary: detail,
      facts: {
        attempt,
        automation_mode: automation.mode,
        outcome,
        permission_policy_ref: automation.permission_policy_ref,
        workflow_ref: link.workflow_ref
      }
    },
    artifact_refs: [{ kind: "report", label: "native Automation run", ref: `automation_runs:${automationRunID}` }],
    provenance: {
      assertion_origin: "system_observation",
      source_kind: "command_execution",
      source_ref: `automation_runs:${automationRunID}`,
      audit_event_ref: `automation_run_events:${automationRunID}`,
      producer: { id: "automation-runner", kind: "automation" }
    },
    redaction: { policy_ref: "automation-evidence-redaction:v1", redacted_paths: [], status: "not_required" }
  };
}

function outcomeHandoff(
  link: AutomationExecutionLink,
  automationRunID: string,
  attempt: number,
  timestamp: string,
  evidence: EvidenceRecord,
  outcome: "succeeded" | "skipped" | "failed",
  detail: string
): HandoffRecord {
  const revision = `automation-run:${automationRunID}:attempt:${attempt}`;
  return {
    schema_version: 1,
    id: makeDomainID("handoff", "derived", `automation-${automationRunID}-${attempt}`) as HandoffID,
    work_id: link.work_id as HandoffRecord["work_id"],
    run_ids: [link.run_id as RunID],
    evidence_ids: [evidence.id],
    revision: 0,
    status: outcome === "succeeded" ? "ready" : "draft",
    summary: `Automation ${outcome}: ${detail}`,
    created_at: timestamp,
    updated_at: timestamp,
    baseline_revision: revision,
    final_revision: revision,
    review_ref: `automation_runs:${automationRunID}`,
    changed_files: [`automation://${automationRunID}/handoff-report`],
    delivery: { mode: "local_changes", working_tree_ref: revision },
    delivery_actions: [],
    risks: outcome === "failed" ? [{
      id: "automation-dispatch-failed", severity: "medium", summary: detail,
      mitigation: "Inspect the linked Automation Evidence and retry policy before any manual replay.",
      source_refs: [`automation_runs:${automationRunID}`]
    }] : [],
    rollback: { availability: "not_required", destructive: false, refs: [] },
    review: { required: false, state: "not_applicable", reviewer_refs: [] }
  };
}

function digest(value: string): string { return createHash("sha256").update(value).digest("hex").slice(0, 24); }
function clean(value: unknown): string { return typeof value === "string" ? value.trim() : ""; }
function safeError(error: unknown): string { return clean(error instanceof Error ? error.message : String(error)) || "automation workflow dispatch failed"; }
