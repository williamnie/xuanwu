import type { RunnerDatabase } from "../db/database.ts";
import { createIssueComment } from "../db/repositories/issueEvents.ts";
import { getIssue, listIssues } from "../db/repositories/issues.ts";
import { createPiAction } from "../db/repositories/pi.ts";
import { listProjects, ProjectNotFoundError, type Project } from "../db/repositories/projects.ts";
import { getAgentSession, listAgentSessions } from "../db/repositories/agentSessions.ts";
import { createProjectStatusSnapshot } from "./projectSnapshot.ts";
import { serializeRefinement, type RefinementField } from "./runnerActionRefinement.ts";

export type PiRunnerActionLayer = {
  commentIssue(input: IssueCommentInput): unknown;
  createIssueProposal(input: IssueCreateProposalInput): unknown;
  createSessionSteerProposal(input: SessionSteerProposalInput): unknown;
  createUpdateRefinementProposal(input: IssueUpdateRefinementInput): unknown;
  enqueueIssueProposal(input: IssueProposalInput): unknown;
  listIssues(input: IssueListInput): unknown;
  listProjects(input: ProjectListInput): unknown;
  listSessions(input: SessionListInput): unknown;
  projectStatus(input: ProjectStatusInput): unknown;
  readIssue(input: IssueReadInput): unknown;
  readSessionSummary(input: SessionReadSummaryInput): unknown;
};

export type PiRunnerActionContext = {
  conversationID?: string;
  project?: Project;
};

type IssueListInput = { project_id?: string; status?: string };
type IssueReadInput = { id: number };
type IssueCommentInput = { body: string; issue_id: number };
type IssueProposalInput = { issue_id: number; rationale?: string };
type IssueUpdateRefinementInput = Partial<Record<RefinementField, string>> & {
  issue_id: number;
  rationale?: string;
};
type IssueCreateProposalInput = {
  acceptance_criteria?: string;
  description: string;
  project_id?: string;
  rationale?: string;
  title?: string;
  verification_plan?: string;
};
type ProjectListInput = {};
type ProjectStatusInput = { project_id?: string };
type SessionListInput = { project_id?: string; provider?: string };
type SessionReadSummaryInput = { session_key: string };
type SessionSteerProposalInput = { prompt: string; rationale?: string; session_key: string };

type ProposalInput = {
  actionType: string;
  issueID?: number;
  payload: Record<string, unknown>;
  rationale?: string;
};

export function createPiRunnerActions(
  db: RunnerDatabase,
  context: PiRunnerActionContext = {}
): PiRunnerActionLayer {
  return {
    commentIssue: (input) => createIssueComment(db, input.issue_id, { author: "agent", body: input.body }),
    createIssueProposal: (input) => createProposal(db, context, issueCreateProposal(input, context)),
    createSessionSteerProposal: (input) => createProposal(db, context, sessionSteerProposal(db, input)),
    createUpdateRefinementProposal: (input) => createProposal(db, context, refinementProposal(db, input)),
    enqueueIssueProposal: (input) => createProposal(db, context, {
      actionType: "issue.enqueue",
      issueID: input.issue_id,
      payload: { issue_id: input.issue_id },
      rationale: input.rationale
    }),
    listIssues: (input) => ({ items: listIssues(db, normalizeIssueFilter(input, context)) }),
    listProjects: () => ({ items: listProjects(db) }),
    listSessions: (input) => ({ items: listAgentSessions(db, normalizeSessionFilter(input, context)) }),
    projectStatus: (input) => createProjectStatusSnapshot(db, scopedProjectID(input.project_id, context)),
    readIssue: (input) => mustGetIssue(db, input.id),
    readSessionSummary: (input) => readSessionSummary(db, input.session_key)
  };
}

function issueCreateProposal(
  input: IssueCreateProposalInput,
  context: PiRunnerActionContext
): ProposalInput {
  const projectID = scopedProjectID(input.project_id, context);
  return {
    actionType: "issue.create",
    payload: {
      project_id: projectID,
      title: input.title ?? "",
      description: issueDescription(input),
      status: "triage"
    },
    rationale: input.rationale
  };
}

function sessionSteerProposal(db: RunnerDatabase, input: SessionSteerProposalInput): ProposalInput {
  const session = readSessionSummary(db, input.session_key);
  return {
    actionType: "session.steer",
    payload: {
      prompt: input.prompt,
      provider: session.provider,
      provider_session_id: session.provider_session_id,
      session_key: session.session_key
    },
    rationale: input.rationale
  };
}

function refinementProposal(db: RunnerDatabase, input: IssueUpdateRefinementInput): ProposalInput {
  const issue = mustGetIssue(db, input.issue_id);
  return {
    actionType: "issue.update_refinement",
    issueID: issue.id,
    payload: {
      issue_id: issue.id,
      patch: { description: serializeRefinement(issue.description, input) }
    },
    rationale: input.rationale
  };
}

function createProposal(
  db: RunnerDatabase,
  context: PiRunnerActionContext,
  input: ProposalInput
) {
  const action = createPiAction(db, {
    id: crypto.randomUUID(),
    action_type: input.actionType,
    conversation_id: cleanString(context.conversationID),
    issue_id: input.issueID ?? 0,
    payload_json: JSON.stringify(input.payload),
    project_id: proposalProjectID(input.payload, context),
    rationale: input.rationale ?? "",
    requires_confirmation: 1,
    risk_level: "high",
    status: "pending"
  });
  return {
    action_id: action.id,
    action_type: action.action_type,
    issue_id: action.issue_id,
    requires_confirmation: action.requires_confirmation === 1,
    risk_level: action.risk_level,
    status: action.status
  };
}

function normalizeIssueFilter(input: IssueListInput, context: PiRunnerActionContext) {
  return {
    projectId: cleanString(input.project_id) || (context.project?.id ?? ""),
    status: cleanString(input.status),
    sourceSessionId: ""
  };
}

function normalizeSessionFilter(input: SessionListInput, context: PiRunnerActionContext) {
  return {
    projectId: cleanString(input.project_id) || (context.project?.id ?? ""),
    provider: cleanString(input.provider)
  };
}

function proposalProjectID(payload: Record<string, unknown>, context: PiRunnerActionContext): string {
  const projectID = cleanString(payload.project_id);
  return projectID || (context.project?.id ?? "");
}

function scopedProjectID(id: unknown, context: PiRunnerActionContext): string {
  const projectID = cleanString(id) || (context.project?.id ?? "");
  if (projectID === "") throw new ProjectNotFoundError();
  return projectID;
}

function mustGetIssue(db: RunnerDatabase, id: number) {
  const issue = getIssue(db, id);
  if (!issue) throw new ProjectNotFoundError();
  return issue;
}

function readSessionSummary(db: RunnerDatabase, sessionKey: string) {
  const key = cleanString(sessionKey);
  const session = getAgentSession(db, key);
  if (!session) throw new Error("session 不存在");
  return {
    agent_role: session.agent_role,
    issue_id: session.issue_id,
    preview: session.preview,
    project_id: session.project_id,
    provider: session.provider,
    provider_session_id: session.provider_session_id,
    session_key: session.session_key,
    status: session.status,
    title: session.title,
    updated_at: session.updated_at
  };
}

function issueDescription(input: IssueCreateProposalInput): string {
  const refinement = serializeRefinement(input.description, {
    acceptance_criteria: input.acceptance_criteria,
    verification_plan: input.verification_plan
  });
  return refinement || input.description;
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
