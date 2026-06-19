import type { RunnerDatabase } from "../db/database.ts";
import { getIssue } from "../db/repositories/issues.ts";
import { ProjectNotFoundError } from "../db/repositories/projects.ts";
import { createPendingPiAction, executeSafePiAction } from "./actionEngine.ts";
import { applyIssueStateRepair, diagnoseIssueState, recommendedRepairPayload } from "./issueStateManager.ts";
import type { PiRunnerActionContext } from "./runnerActions.ts";

type ProposalInput = {
  actionType: string;
  issueID?: number;
  payload: Record<string, unknown>;
  projectID?: string;
  rationale?: string;
};

export type IssueStateDiagnosisInput = {
  deadline_at?: string; project_id?: string; target_issue_ids?: number[]; target_label?: string; target_status?: string;
};
export type IssueStateRepairProposalInput = {
  diagnosis_code?: string; issue_id: number; operation?: string; rationale?: string;
};

export function safeIssueStateDiagnosis(
  db: RunnerDatabase,
  context: PiRunnerActionContext,
  input: IssueStateDiagnosisInput
) {
  const projectID = cleanString(input.project_id) || (context.project?.id ?? "");
  return executeSafePiAction(db, context, {
    actionType: "issue.state_diagnose",
    payload: cleanObject({ project_id: projectID }),
    projectID,
    execute: () => diagnoseIssueState(db, { ...diagnosisOptions(input), projectID })
  });
}

export function createIssueStateRepairProposal(
  db: RunnerDatabase,
  context: PiRunnerActionContext,
  input: IssueStateRepairProposalInput
) {
  const proposal = issueStateRepairProposal(db, input, context);
  return createPendingPiAction(db, context, proposal, () => applyIssueStateRepair(db, proposal.payload));
}

function issueStateRepairProposal(
  db: RunnerDatabase,
  input: IssueStateRepairProposalInput,
  context: PiRunnerActionContext
): ProposalInput {
  const issue = mustGetIssue(db, input.issue_id);
  const payload = recommendedRepairPayload(db, issue.id, {
    diagnosisCode: input.diagnosis_code,
    operation: input.operation,
    projectID: issue.project_id
  });
  return {
    actionType: "issue.state_repair",
    issueID: issue.id,
    payload,
    projectID: issue.project_id || (context.project?.id ?? ""),
    rationale: input.rationale || cleanString(payload.rationale)
  };
}

function diagnosisOptions(input: IssueStateDiagnosisInput) {
  const issueIDs = Array.isArray(input.target_issue_ids) ? input.target_issue_ids : [];
  if (issueIDs.length === 0) return {};
  return {
    batchTarget: {
      deadline_at: cleanString(input.deadline_at),
      issue_ids: issueIDs,
      label: cleanString(input.target_label) || "batch",
      status: cleanString(input.target_status) || "done"
    }
  };
}

function mustGetIssue(db: RunnerDatabase, id: number) {
  const issue = getIssue(db, id);
  if (!issue) throw new ProjectNotFoundError();
  return issue;
}

function cleanObject(input: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== "")) as Record<string, string>;
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
