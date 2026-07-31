import type { RunnerDatabase } from "../db/database.ts";
import { createIssueComment, listIssueEvents, recordIssueEvent } from "../db/repositories/issueEvents.ts";
import { getIssue, type Issue } from "../db/repositories/issues.ts";
import { upsertPiGuardianAlert } from "../db/repositories/pi.ts";
import { getProject } from "../db/repositories/projects.ts";
import { reconcileIssueCompletionFromRuntimeEvidence } from "../domain/evidence/completionGate.ts";
import type { EventBus } from "../events/bus.ts";
import { publishPiNeedsUserNotification } from "../notifications/piNotifier.ts";
import {
  applyIssueStateRepair,
  diagnoseIssueState,
  recommendedRepairPayload
} from "../pi/issueStateManager.ts";
import type { ExecutorProviderId } from "../providers/types.ts";
import { failIssueExecution } from "./statusGate.ts";
import { writeBackVerifierWorkflowEvidence } from "./verifierWorkflowWriteback.ts";

export type ProviderReportedOutcome = {
  outcome: "completed" | "failed" | "needs_user" | "unknown";
  reason: string;
};

export type ReconcileProviderOutcomeInput = {
  bus?: Pick<EventBus, "publish">;
  database: RunnerDatabase;
  issueID: number;
  issueRunID: string;
  now?: Date;
  providerID: ExecutorProviderId;
  providerRunID?: string;
};

/**
 * Provider events are the runtime truth for turn completion. The Runner Host
 * owns the mechanical Issue/Run reconciliation so executors never need to call
 * localhost or a lifecycle CLI.
 */
export async function reconcileProviderOutcome(
  input: ReconcileProviderOutcomeInput
): Promise<Issue | null> {
  const current = getIssue(input.database, input.issueID);
  if (!current || current.status !== "in_progress") return current;
  const reported = providerReportedOutcome(input.database, current.id, input.issueRunID);
  if (reported.outcome === "failed" || reported.outcome === "needs_user") {
    failIssueExecution(
      input.database,
      current.id,
      new Error(reported.reason || `executor reported ${reported.outcome}`),
      input.providerID
    );
    let failed = getIssue(input.database, current.id);
    if (failed && reported.outcome === "failed") {
      const writeback = await writeBackVerifierWorkflowEvidence(input.database, current.id, {
        now: input.now ?? new Date(),
        source: "provider-runtime-host"
      });
      if (writeback.status === "discarded") failed = getIssue(input.database, current.id);
    }
    if (failed && reported.outcome === "needs_user") notifyExecutorNeedsUser(input, failed, reported.reason);
    if (failed) publishIssueStatus(input, failed);
    return failed;
  }
  const now = input.now ?? new Date();
  const diagnostic = diagnoseIssueState(input.database, {
    includeDoneIssues: true,
    issueIDs: [current.id],
    now
  }).diagnostics.find((item) => item.code === "in_progress_session_ended");
  const repair = diagnostic?.recommended_actions.find((action) =>
    action.operation === "patch_status" && action.patch?.status === "pending_verification"
  );
  if (!diagnostic || !repair) return current;
  applyIssueStateRepair(input.database, recommendedRepairPayload(input.database, current.id, {
    diagnosisCode: diagnostic.code,
    includeDoneIssues: true,
    now,
    operation: repair.operation
  }));
  try {
    await reconcileIssueCompletionFromRuntimeEvidence(input.database, current.id, {
      actor: { id: "provider-runtime-host", kind: "runner" },
      correlation_id: `provider-return:${current.id}:${input.providerRunID || input.issueRunID}`,
      now: now.toISOString(),
      source: "provider-runtime-host"
    });
  } catch (error) {
    recordIssueEvent(input.database, current.id, "issue.completion_reconcile_deferred", {
      error: safeError(error),
      provider_run_id: input.providerRunID ?? "",
      reason: "provider completed but completion Evidence/Handoff is incomplete"
    });
  }
  const reconciled = getIssue(input.database, current.id);
  const writeback = await writeBackVerifierWorkflowEvidence(input.database, current.id, {
    now,
    source: "provider-runtime-host"
  });
  if (writeback.status === "completed") {
    const parent = getIssue(input.database, writeback.parent_issue_id);
    if (parent) publishIssueStatus(input, parent);
  }
  const finalized = getIssue(input.database, current.id) ?? reconciled;
  if (finalized) publishIssueStatus(input, finalized);
  return finalized;
}

export function providerReportedOutcome(
  db: RunnerDatabase,
  issueID: number,
  issueRunID: string
): ProviderReportedOutcome {
  const events = listIssueEvents(db, issueID, { limit: 100 });
  for (const event of [...events].reverse()) {
    const payload = parseEventPayload(event.payload);
    if (event.type === "issue.runner_outcome") {
      if (cleanString(payload.issue_run_id) !== issueRunID) continue;
      return {
        outcome: normalizedOutcome(payload.outcome),
        reason: cleanString(payload.reason)
      };
    }
    if (event.type !== "issue.log") continue;
    const correlation = objectValue(payload.runtime_evidence_correlation);
    if (cleanString(correlation.issue_run_id) !== issueRunID) continue;
    const parsed = parseProviderOutcomeMarker(payload.text);
    if (parsed) return parsed;
  }
  return { outcome: "unknown", reason: "" };
}

export function parseProviderOutcomeMarker(value: unknown): ProviderReportedOutcome | null {
  const text = cleanString(value);
  const match = text.match(/^RUNNER_OUTCOME:\s*(completed|failed|needs_user)(?:\s*\|\s*(.+))?$/im);
  if (!match) return null;
  return {
    outcome: match[1] as ProviderReportedOutcome["outcome"],
    reason: cleanString(match[2])
  };
}

function notifyExecutorNeedsUser(
  input: ReconcileProviderOutcomeInput,
  issue: Issue,
  reason: string
): void {
  const project = getProject(input.database, issue.project_id);
  const actionID = `executor-needs-user:${issue.id}:${input.issueRunID}`;
  const message = reason || "Executor 明确报告当前需要用户介入。";
  upsertPiGuardianAlert(input.database, {
    alert_type: "executor_needs_user",
    evidence_json: [`issue:${issue.id}`, `run:${input.issueRunID}`],
    issue_id: issue.id,
    message,
    project_id: issue.project_id,
    run_group_id: actionID,
    severity: "high",
    watchdog_seen_at: (input.now ?? new Date()).toISOString()
  });
  const notification = publishPiNeedsUserNotification({
    actionID,
    bus: input.bus,
    database: input.database,
    diagnosis: "executor_needs_user",
    issue,
    message,
    nextStep: "请查看 Issue 的最终回复和最近日志，补充所需信息或权限后再重试。",
    now: input.now,
    project: { id: issue.project_id, name: project?.name ?? issue.project_id },
    provider: input.providerID
  });
  if (notification) {
    createIssueComment(input.database, issue.id, {
      author: "agent",
      body: `${notification.message}\nAction：${actionID}`
    });
  }
}

function publishIssueStatus(
  input: Pick<ReconcileProviderOutcomeInput, "bus">,
  issue: Issue
): void {
  input.bus?.publish({
    issueId: issue.id,
    payload: JSON.stringify({ status: issue.status }),
    projectId: issue.project_id,
    type: "issue.status_changed"
  });
}

function parseEventPayload(value: string): Record<string, unknown> {
  try {
    return objectValue(JSON.parse(value) as unknown);
  } catch {
    return {};
  }
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizedOutcome(value: unknown): ProviderReportedOutcome["outcome"] {
  const outcome = cleanString(value);
  return outcome === "completed" || outcome === "failed" || outcome === "needs_user"
    ? outcome
    : "unknown";
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
