import type { RunnerDatabase } from "../db/database.ts";
import { enqueueIssue } from "../db/repositories/issueActions.ts";
import { createIssue } from "../db/repositories/issueCreate.ts";
import { auditIssueSkillIntents } from "../skills/intentAudit.ts";
import { getSkillMetadata, readSkillRegistry, recommendSkillIntents } from "../skills/registry.ts";
import { parseSkillIntentList } from "../skills/intents.ts";
import { createIssueComment } from "../db/repositories/issueEvents.ts";
import { getIssue } from "../db/repositories/issues.ts";
import { listProjects, ProjectNotFoundError, type Project } from "../db/repositories/projects.ts";
import { getAgentSession, listAgentSessions } from "../db/repositories/agentSessions.ts";
import { createPiMcpActions, type PiMcpActionLayer } from "./mcpActionTools.ts";
import type { EventBus } from "../events/bus.ts";
import { createPendingPiAction, executeSafePiAction, type PiActionContext } from "./actionEngine.ts";
import { createProjectStatusSnapshot } from "./projectSnapshot.ts";
import { observeSessionProgress } from "./sessionObserver.ts";
import { createIssueStateRepairProposal, safeIssueStateDiagnosis, type IssueStateDiagnosisInput, type IssueStateRepairProposalInput } from "./runnerIssueStateActions.ts";
import { createIssueScheduleEnqueueAction, type IssueScheduleEnqueueInput } from "./runnerIssueScheduleActions.ts";
import { createPiAgentOrchestrationActions, type PiAgentOrchestrationActionLayer } from "./agentOrchestrationActions.ts";
import { createPiRepoReadActions, type PiRepoReadActionLayer } from "./repoReadActionTools.ts";
import {
  createBatchTriageEnqueueAction,
  createNextTriageEnqueueAction,
  type BatchTriageIssueInput,
  type NextTriageIssueInput
} from "./runnerNextTriageActions.ts";
import {
  createCompactIssueList,
  createIssueExecutionStatus,
  createIssueStatusSummary
} from "./issueToolViews.ts";
import {
  renderIssueCreateProposalDescription,
  type IssueProposalContextFields
} from "./issueProposalContext.ts";
import { scopedRunnerChatActionContext } from "./runnerChatAuthorization.ts";
import {
  cancelIssueCompletionWatchAction,
  createIssueCompletionWatchAction,
  listIssueCompletionWatchesAction,
  watchProjectID,
  watchProjectIDForCancel,
  type IssueCompletionWatchCancelInput,
  type IssueCompletionWatchCreateInput,
  type IssueCompletionWatchListInput
} from "./issueCompletionWatchActions.ts";
import {
  runManualContextIntake as executeManualContextIntake,
  type ManualContextIntakeInput
} from "./manualTrigger.ts";
import { loadAssistantToolRegistrySnapshot } from "./toolRegistrySnapshot.ts";
import type { ExecutorProvider, ExecutorProviderId } from "../providers/types.ts";
import { reconcileIssueCompletionFromRuntimeEvidence } from "../domain/evidence/completionGate.ts";

export type PiRunnerActionLayer = PiMcpActionLayer & PiAgentOrchestrationActionLayer & PiRepoReadActionLayer & {
  commentIssue(input: IssueCommentInput): unknown;
  createIssueProposal(input: IssueCreateProposalInput): unknown;
  createIssueStateRepairProposal(input: IssueStateRepairProposalInput): unknown;
  diagnoseIssueState(input: IssueStateDiagnosisInput): unknown;
  createSessionSteerProposal(input: SessionSteerProposalInput): unknown;
  listSkills(input: SkillListInput): unknown;
  readSkill(input: SkillReadInput): unknown;
  recommendSkills(input: SkillRecommendInput): unknown;
  auditSkillIntents(input: SkillIntentAuditInput): unknown;
  enqueueBatchTriageIssues(input: BatchTriageIssueInput): unknown;
  enqueueNextTriageIssue(input: NextTriageIssueInput): unknown;
  createIssueCompletionWatch(input: IssueCompletionWatchCreateInput): unknown;
  listIssueCompletionWatches(input: IssueCompletionWatchListInput): unknown;
  cancelIssueCompletionWatch(input: IssueCompletionWatchCancelInput): unknown;
  enqueueIssueProposal(input: IssueProposalInput): unknown;
  reconcileIssueCompletion(input: IssueCompletionReconcileInput): unknown;
  issueExecutionStatus(input: IssueExecutionStatusInput): unknown;
  issueStatusSummary(input: IssueStatusSummaryInput): unknown;
  runManualContextIntake(input: ManualContextIntakeInput): unknown;
  scheduleIssueEnqueue(input: IssueScheduleEnqueueInput): unknown;
  listIssues(input: IssueListInput): unknown;
  listProjects(input: ProjectListInput): unknown;
  listSessions(input: SessionListInput): unknown;
  projectStatus(input: ProjectStatusInput): unknown;
  readIssue(input: IssueReadInput): unknown;
  readSessionSummary(input: SessionReadSummaryInput): unknown;
};

export type PiRunnerActionContext = PiActionContext & {
  cliConnectorDirs?: string[];
  env?: Record<string, string | undefined>;
  onIssueEnqueued?: (projectID: string) => void;
  project?: Project;
  providers?: Partial<Record<ExecutorProviderId, ExecutorProvider>>;
  sourceTurn?: PiRunnerSourceTurn;
};

export type PiRunnerSourceTurn = {
  id?: string;
  source?: string;
  userPrompt?: string;
};

type IssueListInput = { limit?: number; project_id?: string; status?: string };
type IssueReadInput = { id: number };
type IssueExecutionStatusInput = { id: number };
type IssueCompletionReconcileInput = { issue_id: number; rationale?: string };
type IssueCommentInput = { body: string; issue_id: number };
type IssueProposalInput = { issue_id: number; rationale?: string };
type IssueCreateProposalInput = IssueProposalContextFields & {
  description: string;
  depends_on_issue_ids?: number[];
  project_id?: string;
  rationale?: string;
  title?: string;
  recommended_skill_intents?: string[];
  required_skill_intents?: string[];
  recommended_mcp_capabilities?: string[];
  required_mcp_capabilities?: string[];
};
type ProjectListInput = {};
type SkillListInput = {};
type SkillReadInput = { id: string };
type SkillRecommendInput = { description?: string; project_id?: string; title?: string };
type SkillIntentAuditInput = { issue_id: number; issue_run_id?: string; used_skill_intents?: string[] };
type IssueStatusSummaryInput = { project_id?: string; status?: string };
type ProjectStatusInput = { project_id?: string };
type SessionListInput = { project_id?: string; provider?: string; role?: string };
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
    ...createPiAgentOrchestrationActions(db, context),
    ...createPiMcpActions(db, { ...context, projectID: context.project?.id }),
    ...createPiRepoReadActions(db, context),
    commentIssue: (input) => executeSafePiAction(db, context, {
      actionType: "issue.comment",
      issueID: input.issue_id,
      payload: { body: input.body, issue_id: input.issue_id },
      projectID: issueProjectID(db, input.issue_id, context),
      execute: () => createIssueComment(db, input.issue_id, { author: "agent", body: input.body })
    }),
    createIssueProposal: (input) => {
      const proposal = issueCreateProposal(input, context);
      const actionContext = actionContextForProposal(context, proposal);
      return createPendingPiAction(db, actionContext, proposal, () => createIssue(db, proposal.payload));
    },
    createIssueStateRepairProposal: (input) => createIssueStateRepairProposal(db, context, input),
    diagnoseIssueState: (input) => safeIssueStateDiagnosis(db, context, input),
    createSessionSteerProposal: (input) => createPendingPiAction(db, context, sessionSteerProposal(db, input)),
    auditSkillIntents: (input) => safeSkillIntentAudit(db, context, input),
    enqueueIssueProposal: (input) => {
      const proposal = {
        actionType: "issue.enqueue",
        issueID: input.issue_id,
        payload: { issue_id: input.issue_id },
        projectID: issueProjectID(db, input.issue_id, context),
        rationale: input.rationale
      };
      const actionContext = actionContextForProposal(context, proposal);
      return createPendingPiAction(db, actionContext, proposal, () => enqueueIssueAndNotify(db, context, input.issue_id));
    },
    reconcileIssueCompletion: (input) => reconcileIssueCompletion(db, context, input),
    enqueueBatchTriageIssues: (input) => createBatchTriageEnqueueAction(db, context, input),
    enqueueNextTriageIssue: (input) => createNextTriageEnqueueAction(db, context, input),
    createIssueCompletionWatch: (input) => createCompletionWatch(db, context, input),
    listIssueCompletionWatches: (input) => safeListCompletionWatches(db, context, input),
    cancelIssueCompletionWatch: (input) => cancelCompletionWatch(db, context, input),
    scheduleIssueEnqueue: (input) => createIssueScheduleEnqueueAction(db, context, input),
    issueExecutionStatus: (input) => safeIssueExecutionStatus(db, context, input),
    issueStatusSummary: (input) => safeIssueStatusSummary(db, context, input),
    runManualContextIntake: (input) => manualContextIntake(db, context, input),
    listIssues: (input) => safeListIssues(db, context, input),
    listSkills: () => safeListSkills(db, context),
    listProjects: () => executeSafePiAction(db, context, {
      actionType: "project.list",
      payload: {},
      execute: () => ({ items: listProjects(db) })
    }),
    listSessions: (input) => safeListSessions(db, context, input),
    projectStatus: (input) => safeProjectStatus(db, context, input),
    readSkill: (input) => safeReadSkill(db, context, input),
    recommendSkills: (input) => safeRecommendSkills(db, context, input),
    readIssue: (input) => safeReadIssue(db, context, input),
    readSessionSummary: (input) => safeReadSessionSummary(db, context, input)
  };
}

function manualContextIntake(
  db: RunnerDatabase,
  context: PiRunnerActionContext,
  input: ManualContextIntakeInput
) {
  return executeManualContextIntake(db, {
    ...input,
    conversation_id: cleanString(input.conversation_id) || cleanString(context.conversationID),
    project_id: cleanString(input.project_id) || (context.project?.id ?? ""),
    source_turn_id: cleanString(input.source_turn_id) || cleanString(context.sourceTurn?.id),
    source_turn_source: cleanString(input.source_turn_source) || cleanString(context.sourceTurn?.source) || cleanString(context.source),
    user_prompt: cleanString(input.user_prompt) || cleanString(context.sourceTurn?.userPrompt)
  }, {
    auditContext: {
      conversationID: context.conversationID,
      delegationID: context.delegationID,
      heartbeatID: context.heartbeatID,
      issueID: context.issueID,
      projectID: context.project?.id,
      source: context.source
    },
    connectorManifestDirs: context.cliConnectorDirs,
    env: context.env
  });
}

function createCompletionWatch(
  db: RunnerDatabase,
  context: PiRunnerActionContext,
  input: IssueCompletionWatchCreateInput
) {
  const enrichedInput = {
    ...input,
    origin_conversation_id: cleanString(input.origin_conversation_id) || cleanString(context.conversationID),
    source_event_id: cleanString(input.source_event_id) || cleanString(context.sourceTurn?.id)
  };
  const projectID = watchProjectID(db, enrichedInput);
  const actionContext = scopedRunnerChatActionContext(context, "issue_completion_watch.create", { projectID });
  return createPendingPiAction(db, actionContext, {
    actionType: "issue_completion_watch.create",
    payload: cleanObjectPayload({ ...enrichedInput, project_id: projectID }),
    projectID,
    rationale: enrichedInput.note
  }, () => createIssueCompletionWatchAction(db, { ...enrichedInput, project_id: projectID }));
}

function safeListCompletionWatches(
  db: RunnerDatabase,
  context: PiRunnerActionContext,
  input: IssueCompletionWatchListInput
) {
  const projectID = cleanString(input.project_id) || (context.project?.id ?? "");
  return executeSafePiAction(db, context, {
    actionType: "issue_completion_watch.list",
    payload: cleanObjectPayload({ ...input, project_id: projectID }),
    projectID,
    execute: () => listIssueCompletionWatchesAction(db, { ...input, project_id: projectID })
  });
}

function cancelCompletionWatch(
  db: RunnerDatabase,
  context: PiRunnerActionContext,
  input: IssueCompletionWatchCancelInput
) {
  const projectID = watchProjectIDForCancel(db, input.watch_id);
  const actionContext = scopedRunnerChatActionContext(context, "issue_completion_watch.cancel", { projectID });
  return createPendingPiAction(db, actionContext, {
    actionType: "issue_completion_watch.cancel",
    payload: cleanObjectPayload({ reason: input.reason, watch_id: input.watch_id }),
    projectID,
    rationale: input.reason
  }, () => cancelIssueCompletionWatchAction(db, input));
}

function actionContextForProposal(
  context: PiRunnerActionContext,
  proposal: ProposalInput
): PiRunnerActionContext {
  return scopedRunnerChatActionContext(context, proposal.actionType, {
    issueID: proposal.issueID,
    projectID: proposal.projectID ?? ""
  });
}

function enqueueIssueAndNotify(db: RunnerDatabase, context: PiRunnerActionContext, issueID: number) {
  const issue = enqueueIssue(db, issueID);
  context.onIssueEnqueued?.(issue.project_id);
  return issue;
}

function reconcileIssueCompletion(
  db: RunnerDatabase,
  context: PiRunnerActionContext,
  input: IssueCompletionReconcileInput
) {
  const issue = mustGetIssue(db, input.issue_id);
  const actionType = "issue.completion_reconcile";
  const actionContext = scopedRunnerChatActionContext(context, actionType, {
    issueID: issue.id,
    projectID: issue.project_id
  });
  return createPendingPiAction(db, actionContext, {
    actionType,
    issueID: issue.id,
    payload: { issue_id: issue.id, rationale: cleanString(input.rationale) },
    projectID: issue.project_id,
    rationale: input.rationale
  }, async () => {
    const result = await reconcileIssueCompletionFromRuntimeEvidence(db, issue.id, {
      actor: { id: "pi-completion-reconciliation", kind: "supervisor" },
      source: "pi-issue-completion-reconciliation"
    });
    if (result.issue.status === "done") context.onIssueEnqueued?.(result.issue.project_id);
    return completionReconciliationResult(result);
  });
}

function completionReconciliationResult(
  result: Awaited<ReturnType<typeof reconcileIssueCompletionFromRuntimeEvidence>>
) {
  return {
    issue: {
      id: result.issue.id,
      project_id: result.issue.project_id,
      status: result.issue.status,
      title: result.issue.title
    },
    target_status: result.target_status,
    transition_path: result.transition_path
  };
}


function safeListIssues(db: RunnerDatabase, context: PiRunnerActionContext, input: IssueListInput) {
  const filter = normalizeIssueFilter(input, context);
  return executeSafePiAction(db, context, {
    actionType: "issue.list",
    payload: cleanObjectPayload({ limit: input.limit, project_id: filter.projectId, status: filter.status }),
    projectID: filter.projectId,
    execute: () => createCompactIssueList(db, {
      limit: input.limit,
      projectId: filter.projectId,
      status: filter.status
    })
  });
}

function safeIssueStatusSummary(db: RunnerDatabase, context: PiRunnerActionContext, input: IssueStatusSummaryInput) {
  const filter = normalizeIssueFilter(input, context);
  return executeSafePiAction(db, context, {
    actionType: "issue.status_summary",
    payload: cleanObject({ project_id: filter.projectId, status: filter.status }),
    projectID: filter.projectId,
    execute: () => createIssueStatusSummary(db, {
      projectId: filter.projectId,
      status: filter.status
    })
  });
}

function safeIssueExecutionStatus(db: RunnerDatabase, context: PiRunnerActionContext, input: IssueExecutionStatusInput) {
  const issue = mustGetIssue(db, input.id);
  return executeSafePiAction(db, context, {
    actionType: "issue.execution_status",
    issueID: issue.id,
    payload: { id: issue.id },
    projectID: issue.project_id,
    execute: () => createIssueExecutionStatus(db, issue.id)
  });
}

function safeListSessions(db: RunnerDatabase, context: PiRunnerActionContext, input: SessionListInput) {
  const filter = normalizeSessionFilter(input, context);
  return executeSafePiAction(db, context, {
    actionType: "session.list",
    payload: cleanObject({ project_id: filter.projectId, provider: filter.provider, role: filter.role }),
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
    status: project.hold?.reason ? `hold:${project.hold.reason}` : "active"
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
  const description = renderIssueCreateProposalDescription(input, { project: context.project, projectID });
  return {
    actionType: "issue.create",
    payload: {
      project_id: projectID,
      title: input.title ?? "",
      description,
      ...(input.depends_on_issue_ids === undefined
        ? {}
        : { depends_on_issue_ids: input.depends_on_issue_ids }),
      required_skill_intents: parseSkillIntentList(input.required_skill_intents),
      recommended_skill_intents: parseSkillIntentList(input.recommended_skill_intents),
      required_mcp_capabilities: input.required_mcp_capabilities ?? [],
      recommended_mcp_capabilities: input.recommended_mcp_capabilities ?? [],
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

function safeListSkills(db: RunnerDatabase, context: PiRunnerActionContext) {
  return executeSafePiAction(db, context, {
    actionType: "skill.list",
    payload: {},
    execute: () => readSkillRegistry({ availableTools: skillRegistryTools(db) })
  });
}

function safeReadSkill(db: RunnerDatabase, context: PiRunnerActionContext, input: SkillReadInput) {
  return executeSafePiAction(db, context, {
    actionType: "skill.read",
    payload: { id: cleanString(input.id) },
    execute: () => getSkillMetadata(input.id, { availableTools: skillRegistryTools(db) }) ?? { id: cleanString(input.id), missing: true }
  });
}

function safeRecommendSkills(db: RunnerDatabase, context: PiRunnerActionContext, input: SkillRecommendInput) {
  const projectID = cleanString(input.project_id) || (context.project?.id ?? "");
  return executeSafePiAction(db, context, {
    actionType: "skill.recommend",
    payload: cleanObjectPayload({ project_id: projectID, title: input.title ?? "", description: input.description ?? "" }),
    projectID,
    execute: () => ({ items: recommendSkillIntents(input) })
  });
}

function skillRegistryTools(db: RunnerDatabase) {
  return loadAssistantToolRegistrySnapshot(db).tools.map((tool) => ({
    aliases: cleanString(tool.metadata?.capability_id) ? [cleanString(tool.metadata?.capability_id)] : [],
    name: tool.name,
    permission: tool.permission,
    provider_id: tool.provider_id
  }));
}

function safeSkillIntentAudit(db: RunnerDatabase, context: PiRunnerActionContext, input: SkillIntentAuditInput) {
  const issue = mustGetIssue(db, input.issue_id);
  return executeSafePiAction(db, context, {
    actionType: "skill.intent_audit",
    issueID: issue.id,
    payload: cleanObjectPayload({ issue_id: issue.id, issue_run_id: input.issue_run_id ?? "", used_skill_intents: input.used_skill_intents ?? [] }),
    projectID: issue.project_id,
    execute: () => auditIssueSkillIntents(db, issue.id, { issueRunID: input.issue_run_id, usedSkillIntents: input.used_skill_intents })
  });
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
    provider: cleanString(input.provider),
    role: cleanString(input.role)
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

function cleanObject(input: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== "")) as Record<string, string>;
}

function cleanObjectPayload(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => (
    Array.isArray(value) ? value.length > 0 : value !== undefined && value !== ""
  )));
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
