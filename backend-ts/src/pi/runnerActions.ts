import type { RunnerDatabase } from "../db/database.ts";
import { enqueueIssue } from "../db/repositories/issueActions.ts";
import { createIssue } from "../db/repositories/issueCreate.ts";
import { createIssueComment } from "../db/repositories/issueEvents.ts";
import { getIssue, listIssues } from "../db/repositories/issues.ts";
import { updateIssue } from "../db/repositories/issueUpdate.ts";
import { listProjects, ProjectNotFoundError, type Project } from "../db/repositories/projects.ts";
import { getAgentSession, listAgentSessions } from "../db/repositories/agentSessions.ts";
import type { EventBus } from "../events/bus.ts";
import { createPendingPiAction, executeSafePiAction, type PiActionContext } from "./actionEngine.ts";
import { createProjectStatusSnapshot } from "./projectSnapshot.ts";
import { serializeRefinement, type RefinementField } from "./runnerActionRefinement.ts";
import { observeSessionProgress } from "./sessionObserver.ts";
import { createIssueStateRepairProposal, safeIssueStateDiagnosis, type IssueStateDiagnosisInput, type IssueStateRepairProposalInput } from "./runnerIssueStateActions.ts";

export type PiRunnerActionLayer = {
  commentIssue(input: IssueCommentInput): unknown;
  createIssueProposal(input: IssueCreateProposalInput): unknown;
  createIssueStateRepairProposal(input: IssueStateRepairProposalInput): unknown;
  diagnoseIssueState(input: IssueStateDiagnosisInput): unknown;
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

export type PiRunnerActionContext = PiActionContext & { project?: Project };

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
  projectID?: string;
  rationale?: string;
};

export function createPiRunnerActions(
  db: RunnerDatabase,
  context: PiRunnerActionContext = {}
): PiRunnerActionLayer {
  return {
    commentIssue: (input) => executeSafePiAction(db, context, {
      actionType: "issue.comment",
      issueID: input.issue_id,
      payload: { body: input.body, issue_id: input.issue_id },
      projectID: issueProjectID(db, input.issue_id, context),
      execute: () => createIssueComment(db, input.issue_id, { author: "agent", body: input.body })
    }),
    createIssueProposal: (input) => {
      const proposal = issueCreateProposal(input, context);
      return createPendingPiAction(db, context, proposal, () => createIssue(db, proposal.payload));
    },
    createIssueStateRepairProposal: (input) => createIssueStateRepairProposal(db, context, input),
    diagnoseIssueState: (input) => safeIssueStateDiagnosis(db, context, input),
    createSessionSteerProposal: (input) => createPendingPiAction(db, context, sessionSteerProposal(db, input)),
    createUpdateRefinementProposal: (input) => {
      const proposal = refinementProposal(db, input);
      return createPendingPiAction(db, context, proposal, () => updateIssue(db, input.issue_id, objectPayload(proposal.payload.patch)));
    },
    enqueueIssueProposal: (input) => {
      const proposal = {
        actionType: "issue.enqueue",
        issueID: input.issue_id,
        payload: { issue_id: input.issue_id },
        projectID: issueProjectID(db, input.issue_id, context),
        rationale: input.rationale
      };
      return createPendingPiAction(db, context, proposal, () => enqueueIssue(db, input.issue_id));
    },
    listIssues: (input) => safeListIssues(db, context, input),
    listProjects: () => executeSafePiAction(db, context, {
      actionType: "project.list",
      payload: {},
      execute: () => ({ items: listProjects(db) })
    }),
    listSessions: (input) => safeListSessions(db, context, input),
    projectStatus: (input) => safeProjectStatus(db, context, input),
    readIssue: (input) => safeReadIssue(db, context, input),
    readSessionSummary: (input) => safeReadSessionSummary(db, context, input)
  };
}


function safeListIssues(db: RunnerDatabase, context: PiRunnerActionContext, input: IssueListInput) {
  const filter = normalizeIssueFilter(input, context);
  return executeSafePiAction(db, context, {
    actionType: "issue.list",
    payload: cleanObject({ project_id: filter.projectId, status: filter.status }),
    projectID: filter.projectId,
    execute: () => ({ items: listIssues(db, filter) })
  });
}

function safeListSessions(db: RunnerDatabase, context: PiRunnerActionContext, input: SessionListInput) {
  const filter = normalizeSessionFilter(input, context);
  return executeSafePiAction(db, context, {
    actionType: "session.list",
    payload: cleanObject({ project_id: filter.projectId, provider: filter.provider }),
    projectID: filter.projectId,
    execute: () => ({ items: listAgentSessions(db, filter) })
  });
}

function safeProjectStatus(db: RunnerDatabase, context: PiRunnerActionContext, input: ProjectStatusInput) {
  const projectID = cleanString(input.project_id) || (context.project?.id ?? "");
  if (projectID === "") return safeGlobalProjectStatus(db, context);
  return executeSafePiAction(db, context, {
    actionType: "project.status",
    payload: { project_id: projectID },
    projectID,
    execute: () => createProjectStatusSnapshot(db, projectID)
  });
}

function safeGlobalProjectStatus(db: RunnerDatabase, context: PiRunnerActionContext) {
  return executeSafePiAction(db, context, {
    actionType: "project.status",
    payload: {},
    execute: () => ({ items: listProjects(db).map(projectStatusSummary) })
  });
}

function projectStatusSummary(project: Project) {
  return {
    id: project.id,
    name: project.name,
    provider: project.provider,
    status: project.hold_reason ? `hold:${project.hold_reason}` : "active"
  };
}

function safeReadIssue(db: RunnerDatabase, context: PiRunnerActionContext, input: IssueReadInput) {
  const issue = mustGetIssue(db, input.id);
  return executeSafePiAction(db, context, {
    actionType: "issue.read",
    issueID: issue.id,
    payload: { id: issue.id },
    projectID: issue.project_id,
    execute: () => issue
  });
}

function safeReadSessionSummary(db: RunnerDatabase, context: PiRunnerActionContext, input: SessionReadSummaryInput) {
  const session = readSessionSummary(db, input.session_key);
  return executeSafePiAction(db, context, {
    actionType: "session.read_summary",
    payload: { session_key: session.session_key },
    projectID: session.project_id,
    execute: () => session
  });
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
    projectID,
    rationale: input.rationale
  };
}

function sessionSteerProposal(db: RunnerDatabase, input: SessionSteerProposalInput): ProposalInput {
  const session = readSessionSummary(db, input.session_key);
  const progress = observeSessionProgress(db, session.session_key);
  return {
    actionType: "session.steer",
    payload: {
      prompt: input.prompt,
      progress_context: progress.summary,
      provider: session.provider,
      provider_session_id: session.provider_session_id,
      session_key: session.session_key
    },
    projectID: session.project_id,
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
    projectID: issue.project_id,
    rationale: input.rationale
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

function scopedProjectID(id: unknown, context: PiRunnerActionContext): string {
  const projectID = cleanString(id) || (context.project?.id ?? "");
  if (projectID === "") throw new ProjectNotFoundError();
  return projectID;
}

function issueProjectID(db: RunnerDatabase, id: number, context: PiRunnerActionContext): string {
  return mustGetIssue(db, id).project_id || (context.project?.id ?? "");
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
    progress: observeSessionProgress(db, key),
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

function objectPayload(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function cleanObject(input: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== "")) as Record<string, string>;
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
