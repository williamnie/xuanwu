import type { RunnerDatabase } from "../db/database.ts";
import { createIssue } from "../db/repositories/issueCreate.ts";
import { createIssueComment } from "../db/repositories/issueEvents.ts";
import { updateIssue } from "../db/repositories/issueUpdate.ts";
import type { Project } from "../db/repositories/projects.ts";
import { createPendingPiAction, executeSafePiAction, type PiActionContext } from "./actionEngine.ts";
import { scopedRunnerChatActionContext } from "./runnerChatAuthorization.ts";
import {
  createAgentWorkflowProposal,
  createExecutorAssignmentProposal,
  createNeedsUserEscalationProposal,
  recommendExecutorProfile,
  type AgentRecommendationInput,
  type AgentWorkflowInput,
  type ExecutorAssignmentInput,
  type NeedsUserEscalationInput
} from "./agentOrchestration.ts";

export type PiAgentOrchestrationActionLayer = {
  assignExecutorProfileProposal(input: ExecutorAssignmentInput): unknown;
  createExecutorIssueProposal(input: AgentWorkflowInput): unknown;
  createReportWorkflow(input: AgentWorkflowInput): unknown;
  createReviewWorkflow(input: AgentWorkflowInput): unknown;
  createVerificationWorkflow(input: AgentWorkflowInput): unknown;
  escalateNeedsUser(input: NeedsUserEscalationInput): unknown;
  recommendExecutorProfile(input: AgentRecommendationInput): unknown;
};

type OrchestrationContext = PiActionContext & {
  onIssueEnqueued?: (projectID: string) => void;
  project?: Project;
};

export function createPiAgentOrchestrationActions(
  db: RunnerDatabase,
  context: OrchestrationContext
): PiAgentOrchestrationActionLayer {
  return {
    assignExecutorProfileProposal: (input) => assignExecutorProfileProposal(db, context, input),
    createExecutorIssueProposal: (input) => createAgentWorkflowAction(db, context, { ...input, role: "executor" }),
    createReportWorkflow: (input) => createAgentWorkflowAction(db, context, { ...input, role: "reporter" }),
    createReviewWorkflow: (input) => createAgentWorkflowAction(db, context, { ...input, role: "reviewer" }),
    createVerificationWorkflow: (input) => createAgentWorkflowAction(db, context, { ...input, role: "verifier" }),
    escalateNeedsUser: (input) => escalateNeedsUser(db, context, input),
    recommendExecutorProfile: (input) => safeRecommendExecutorProfile(db, context, input)
  };
}

function assignExecutorProfileProposal(
  db: RunnerDatabase,
  context: OrchestrationContext,
  input: ExecutorAssignmentInput
) {
  const proposal = createExecutorAssignmentProposal(db, context.project, input);
  return createPendingPiAction(
    db,
    context,
    { ...proposal, actionType: "agent.executor_assign" },
    () => updateIssue(db, input.issue_id, objectPayload(proposal.payload.patch))
  );
}

function createAgentWorkflowAction(db: RunnerDatabase, context: OrchestrationContext, input: AgentWorkflowInput) {
  const proposal = createAgentWorkflowProposal(db, context.project, input);
  const actionType = "agent.workflow_request";
  const payload = input.role === "verifier" || input.role === "reviewer"
    ? { ...proposal.payload, status: "todo" }
    : proposal.payload;
  const actionContext = scopedRunnerChatActionContext(context, actionType, {
    issueID: proposal.issueID,
    projectID: proposal.projectID ?? ""
  });
  return createPendingPiAction(
    db,
    actionContext,
    { ...proposal, actionType, goalID: proposal.goalID, payload },
    () => {
      const issue = createIssue(db, payload);
      if (issue.status === "todo") context.onIssueEnqueued?.(issue.project_id);
      return issue;
    }
  );
}

function escalateNeedsUser(db: RunnerDatabase, context: OrchestrationContext, input: NeedsUserEscalationInput) {
  const proposal = createNeedsUserEscalationProposal(db, input);
  return createPendingPiAction(
    db,
    context,
    { ...proposal, actionType: "needs_user.escalate" },
    () => createIssueComment(db, input.issue_id, { author: "agent", body: String(proposal.payload.body ?? "") })
  );
}

function safeRecommendExecutorProfile(
  db: RunnerDatabase,
  context: OrchestrationContext,
  input: AgentRecommendationInput
) {
  const result = recommendExecutorProfile(db, context.project, input);
  return executeSafePiAction(db, context, {
    actionType: "agent.profile_recommend",
    issueID: result.issue_id || undefined,
    payload: cleanObjectPayload({ issue_id: result.issue_id, project_id: result.project_id, role: result.agent_role }),
    projectID: result.project_id,
    execute: () => result
  });
}

function objectPayload(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function cleanObjectPayload(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => (
    Array.isArray(value) ? value.length > 0 : value !== undefined && value !== ""
  )));
}
