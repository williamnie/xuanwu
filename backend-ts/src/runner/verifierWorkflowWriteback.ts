import { createHash } from "node:crypto";
import type { RunnerDatabase } from "../db/database.ts";
import { recordEvidenceRecords } from "../db/repositories/evidence.ts";
import { recordIssueEvent } from "../db/repositories/issueEvents.ts";
import { getIssue, listIssueRuns, type Issue } from "../db/repositories/issues.ts";
import { listPiActions } from "../db/repositories/pi.ts";
import { updateIssue } from "../db/repositories/issueUpdate.ts";
import {
  createIssueVerifierReview,
  projectIssueRuntimeEvidence,
  reconcileIssueCompletionFromRuntimeEvidence
} from "../domain/evidence/completionGate.ts";
import type { EvidenceRecord } from "../domain/evidence/contracts.ts";
import { issueAsWork } from "../domain/work/issueAdapter.ts";
import { makeRunAttemptID } from "../domain/run/contracts.ts";
import { readIssueVerificationProjection } from "../domain/review/humanReview.ts";
import { redactSensitiveText } from "../util/redact.ts";
import { makeDomainID } from "../xuanwu/coreDomainContracts.ts";

export type VerifierWorkflowWritebackResult = {
  evidence: number;
  parent_issue_id: number;
  status: "completed" | "discarded" | "not_verifier" | "not_ready" | "skipped";
};

/**
 * A verifier child is an isolated execution carrier, not the owner of the
 * acceptance decision. Only passed, tool-produced Evidence from its canonical
 * Run is re-bound to the parent Work/current Run. The normal deterministic
 * completion gate then remains the sole authority that can complete the parent.
 */
export async function writeBackVerifierWorkflowEvidence(
  db: RunnerDatabase,
  childIssueID: number,
  options: { now?: Date; source?: string } = {}
): Promise<VerifierWorkflowWritebackResult> {
  const child = getIssue(db, childIssueID);
  const parentID = child ? verifierParentIssueID(child) : 0;
  if (!child || parentID === 0 || !authorizedVerifierCarrier(db, child, parentID)) {
    return { evidence: 0, parent_issue_id: 0, status: "not_verifier" };
  }
  if (child.status !== "done" && child.status !== "failed" && child.status !== "pending_verification") {
    return { evidence: 0, parent_issue_id: parentID, status: "not_ready" };
  }
  const parent = getIssue(db, parentID);
  if (
    !parent
    || (parent.status !== "pending_verification" && parent.status !== "failed")
    || readIssueVerificationProjection(db, parent.id).owner !== "pi"
  ) {
    return { evidence: 0, parent_issue_id: parentID, status: "skipped" };
  }
  if (child.status === "failed") {
    return discardVerifierCarrier(db, child, parentID, options.source);
  }
  const now = options.now ?? new Date();
  const childProjection = await projectIssueRuntimeEvidence(
    db,
    child.id,
    now.toISOString(),
    { persist_artifacts: true }
  );
  const review = createIssueVerifierReview(child, {
    evidence: childProjection.evidence,
    now: now.toISOString(),
    projection_errors: childProjection.errors,
    run: childProjection.run
  });
  if (review.evaluation.decision !== "passed") {
    if (child.status === "pending_verification") {
      return discardVerifierCarrier(db, child, parentID, options.source);
    }
    return { evidence: 0, parent_issue_id: parentID, status: "not_ready" };
  }
  const parentRun = listIssueRuns(db, parent.id).at(-1);
  if (!parentRun || parentRun.ended_at === "") {
    return { evidence: 0, parent_issue_id: parentID, status: "not_ready" };
  }

  const promoted = childProjection.evidence
    .filter((evidence) => evidence.status === "passed" && isExecutableEvidence(evidence))
    .map((evidence) => parentEvidence(parent, parentRun, child, evidence));
  if (promoted.length === 0) {
    return { evidence: 0, parent_issue_id: parentID, status: "not_ready" };
  }
  recordEvidenceRecords(db, parent.id, promoted, {
    recorded_at: now.toISOString(),
    source: options.source ?? "verifier-workflow-writeback"
  });
  recordIssueEvent(db, parent.id, "issue.verifier_evidence_promoted.v1", {
    child_issue_id: child.id,
    child_run_id: childProjection.run?.id ?? "",
    evidence_ids: promoted.map((evidence) => evidence.id),
    parent_run_id: parentRun.id,
    source: options.source ?? "verifier-workflow-writeback"
  });
  try {
    await reconcileIssueCompletionFromRuntimeEvidence(db, parent.id, {
      actor: { id: "pi-verifier-workflow-writeback", kind: "runner" },
      correlation_id: `verifier-workflow:${child.id}:parent:${parent.id}`,
      now: now.toISOString(),
      source: options.source ?? "verifier-workflow-writeback"
    });
  } catch (error) {
    recordIssueEvent(db, parent.id, "issue.verifier_writeback_deferred.v1", {
      child_issue_id: child.id,
      error: redactSensitiveText(error instanceof Error ? error.message : String(error)),
      evidence_ids: promoted.map((evidence) => evidence.id),
      source: options.source ?? "verifier-workflow-writeback"
    });
    return { evidence: promoted.length, parent_issue_id: parent.id, status: "not_ready" };
  }
  return {
    evidence: promoted.length,
    parent_issue_id: parent.id,
    status: "completed"
  };
}

function discardVerifierCarrier(
  db: RunnerDatabase,
  child: Issue,
  parentIssueID: number,
  source = "verifier-workflow-writeback"
): VerifierWorkflowWritebackResult {
  const error = "Verifier workflow produced no captured passing test/lint/build Evidence; PI discarded this internal attempt and will retry autonomously.";
  updateIssue(db, child.id, { error, status: "cancelled" });
  recordIssueEvent(db, child.id, "issue.verifier_contract_failed.v1", {
    error,
    parent_issue_id: parentIssueID,
    source
  });
  return { evidence: 0, parent_issue_id: parentIssueID, status: "discarded" };
}

function authorizedVerifierCarrier(db: RunnerDatabase, child: Issue, parentIssueID: number): boolean {
  return listPiActions(db, { issueId: parentIssueID, status: "completed" }).some((action) => {
    if (action.action_type !== "agent.workflow_request" || action.gate_decision !== "execute") return false;
    const result = objectPayload(action.result_json);
    if (result.id !== child.id || result.project_id !== child.project_id) return false;
    const payload = objectPayload(action.payload_json);
    const snapshot = objectPayload(cleanString(payload.workflow_snapshot_json));
    return cleanString(snapshot.agent_role) === "verifier"
      && snapshot.parent_issue_id === parentIssueID;
  });
}

function parentEvidence(
  parent: Issue,
  parentRun: ReturnType<typeof listIssueRuns>[number],
  child: Issue,
  evidence: EvidenceRecord
): EvidenceRecord {
  const runID = makeDomainID("run", "issue_runs", parentRun.id);
  const localID = `verifier-${child.id}-${createHash("sha256").update(evidence.id).digest("hex").slice(0, 20)}`;
  return {
    ...evidence,
    id: makeDomainID("evidence", "issue_events", localID),
    work_id: issueAsWork(parent).id,
    run_id: runID,
    attempt_id: makeRunAttemptID(runID, parentRun.attempt),
    revision: 0,
    decisive_output: {
      ...evidence.decisive_output,
      summary: `Verifier Issue #${child.id}: ${evidence.decisive_output.summary}`,
      facts: {
        ...evidence.decisive_output.facts,
        verifier_child_issue_id: child.id
      }
    },
    provenance: {
      ...evidence.provenance,
      assertion_origin: "system_observation",
      source_ref: evidence.id,
      audit_event_ref: `verifier-workflow:${child.id}:evidence:${evidence.id}`,
      producer: { id: "pi-verifier-workflow-writeback", kind: "runner" }
    }
  };
}

function verifierParentIssueID(issue: Issue): number {
  const snapshot = objectPayload(issue.workflow_snapshot_json);
  if (cleanString(snapshot.agent_role) !== "verifier") return 0;
  const value = snapshot.parent_issue_id;
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function isExecutableEvidence(evidence: EvidenceRecord): boolean {
  return evidence.kind === "test" || evidence.kind === "lint" || evidence.kind === "build";
}

function objectPayload(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
