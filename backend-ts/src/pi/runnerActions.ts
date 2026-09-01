import type { RunnerDatabase } from "../db/database.ts";
import type { RunnerConfig } from "../config/env.ts";
import { deleteIssues, enqueueIssue } from "../db/repositories/issueActions.ts";
import { createIssue } from "../db/repositories/issueCreate.ts";
import { auditIssueSkillIntents } from "../skills/intentAudit.ts";
import { getSkillMetadata, readSkillRegistry, recommendSkillIntents } from "../skills/registry.ts";
import { parseSkillIntentList } from "../skills/intents.ts";
import { createIssueComment } from "../db/repositories/issueEvents.ts";
import { getIssue, type Issue } from "../db/repositories/issues.ts";
import { listProjects, ProjectNotFoundError, type Project } from "../db/repositories/projects.ts";
import { getAgentSessionByReference, listAgentSessions } from "../db/repositories/agentSessions.ts";
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
  humanReviewExpectedState,
  issueBatchExpectedState,
  issueEnqueueExpectedState,
  sessionExpectedState
} from "./actionFreshness.ts";
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
import type { ProviderCatalogEntry } from "../providers/core/catalog.ts";
import { requestIssuePiAcceptance } from "../runner/piAcceptanceRequest.ts";
import { materializeIssueBatch, normalizeIssueBatchPayload } from "./issueBatchProposal.ts";
import { readIssueDependency } from "../domain/work/issueDependency.ts";
import {
  allowedIssueStatusTargets,
  executeIssueStatusUpdate,
  prepareIssueStatusUpdate,
  type IssueStatusUpdateInput
} from "./runnerIssueStatusActions.ts";
import {
  createHumanReviewRequest as createHumanReviewRequestRecord,
  readIssueDecisionProjection,
  reviewHumanIssue,
  type CreateHumanReviewRequestInput
} from "../domain/review/humanReview.ts";
import {
  readRunnerSettings,
  updateRunnerSettings as applyRunnerSettings
} from "../http/runnerSettingsApi.ts";
import {
  scheduleSystemRestart,
  type SystemRestartAuditEvent
} from "../http/systemRestartApi.ts";

export type PiRunnerActionLayer = PiMcpActionLayer & PiAgentOrchestrationActionLayer & PiRepoReadActionLayer & {
  commentIssue(input: IssueCommentInput): unknown;
  cancelIssues(input: IssueCancelInput): unknown;
  deleteIssues(input: IssueDeleteInput): unknown;
  updateIssueStatuses(input: IssueStatusUpdateInput): unknown;
  createIssueProposal(input: IssueCreateProposalInput): unknown;
  createIssueBatchProposal(input: IssueCreateBatchProposalInput): unknown;
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
  requestIssueAcceptanceAction(input: IssueAcceptanceRequestInput): unknown;
  issueExecutionStatus(input: IssueExecutionStatusInput): unknown;
  issueStatusSummary(input: IssueStatusSummaryInput): unknown;
  runManualContextIntake(input: ManualContextIntakeInput): unknown;
  scheduleIssueEnqueue(input: IssueScheduleEnqueueInput): unknown;
  listIssues(input: IssueListInput): unknown;
  listProjects(input: ProjectListInput): unknown;
  listSessions(input: SessionListInput): unknown;
  projectStatus(input: ProjectStatusInput): unknown;
  readIssue(input: IssueReadInput): unknown;
  readRunnerSettings(input: object): unknown;
  readSessionSummary(input: SessionReadSummaryInput): unknown;
  restartSystem(input: SystemRestartInput): unknown;
  updateRunnerSettings(input: RunnerSettingsUpdateInput): unknown;
  createHumanReviewRequest(input: CreateHumanReviewRequestInput & { issue_id: number }): unknown;
  respondToHumanReview(input: HumanReviewResponseInput): unknown;
};

export type PiRunnerActionContext = PiActionContext & {
  auditSystemRestart?: (event: SystemRestartAuditEvent) => void;
  cliConnectorDirs?: string[];
  config?: RunnerConfig;
  env?: Record<string, string | undefined>;
  issueID?: number;
  issueQueryDefaultScope?: "global" | "project";
  notificationTarget?: {
    connectorID: string;
    conversationID: string;
    replyToMessageID?: string;
    threadID?: string;
  };
  onIssueEnqueued?: (projectID: string) => void;
  project?: Project;
  providers?: Partial<Record<ExecutorProviderId, ExecutorProvider>>;
  codeAgentCatalog?: readonly ProviderCatalogEntry[];
  restartDelayMs?: number;
  restartProcess?: () => void;
  sourceTurn?: PiRunnerSourceTurn;
  supervisorManaged?: boolean;
};

export type PiRunnerSourceTurn = {
  id?: string;
  source?: string;
  userPrompt?: string;
};

type IssueQueryScope = "global" | "project";
type IssueListInput = { limit?: number; project_id?: string; scope?: IssueQueryScope; status?: string };
type IssueReadInput = { id: number };
type IssueExecutionStatusInput = { id: number };
type IssueAcceptanceRequestInput = { issue_id: number; rationale?: string };
type IssueCommentInput = { body: string; issue_id: number };
type HumanReviewResponseInput = {
  action: "accept" | "request_changes" | "reject";
  comment?: string;
  issue_id: number;
  review_request_id: string;
  review_revision: number;
};
type IssueCancelInput = { issue_ids: number[]; rationale?: string };
type IssueDeleteInput = { issue_ids: number[]; reason: string };
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
type IssueCreateBatchProposalInput = {
  items: Array<Omit<IssueCreateProposalInput, "project_id"> & { ref: string; depends_on_refs?: string[] }>;
  project_id?: string;
  rationale?: string;
};
type ProjectListInput = {};
type SkillListInput = {};
type SkillReadInput = { id: string };
type SkillRecommendInput = { description?: string; project_id?: string; title?: string };
type SkillIntentAuditInput = { issue_id: number; issue_run_id?: string; used_skill_intents?: string[] };
type IssueStatusSummaryInput = { project_id?: string; scope?: IssueQueryScope; status?: string };
type ProjectStatusInput = { project_id?: string };
type SessionListInput = { project_id?: string; provider?: string; role?: string };
type SessionReadSummaryInput = { session_key: string };
type SessionSteerProposalInput = { prompt: string; rationale?: string; session_key: string };
type RunnerSettingsUpdateInput = {
  codex_app_command?: string;
  codex_cli_command?: string;
  codex_server_mode?: "app" | "cli";
  max_parallel_projects?: number;
  reason: string;
};
type SystemRestartInput = { reason: string };

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
    createHumanReviewRequest: (input) => executeSafePiAction(db, context, {
      actionType: "human_review.request",
      issueID: input.issue_id,
      payload: cleanObjectPayload(input),
      projectID: issueProjectID(db, input.issue_id, context),
      execute: () => createHumanReviewRequestRecord(db, input.issue_id, input, { bus: context.bus })
    }),
    respondToHumanReview: (input) => respondToHumanReview(db, context, input),
    cancelIssues: (input) => cancelIssues(db, context, input),
    deleteIssues: (input) => deleteIssuesProposal(db, context, input),
    updateIssueStatuses: (input) => updateIssueStatuses(db, context, input),
    createIssueProposal: (input) => {
      const proposal = issueCreateProposal(input, context);
      const actionContext = actionContextForProposal(context, proposal);
      return createPendingPiAction(db, actionContext, proposal, () => createIssue(db, proposal.payload));
    },
    createIssueBatchProposal: (input) => {
      const proposal = issueCreateBatchProposal(input, context);
      const actionContext = actionContextForProposal(context, proposal);
      return createPendingPiAction(db, actionContext, proposal, () => materializeIssueBatch(db, proposal.payload));
    },
    createIssueStateRepairProposal: (input) => createIssueStateRepairProposal(db, context, input),
    diagnoseIssueState: (input) => safeIssueStateDiagnosis(db, context, input),
    createSessionSteerProposal: (input) => createPendingPiAction(db, context, sessionSteerProposal(db, input)),
    auditSkillIntents: (input) => safeSkillIntentAudit(db, context, input),
    enqueueIssueProposal: (input) => {
      const issue = mustGetIssue(db, input.issue_id);
      const proposal = {
        actionType: "issue.enqueue",
        issueID: input.issue_id,
        payload: {
          issue_id: input.issue_id,
          expected_state: issueEnqueueExpectedState(issue)
        },
        projectID: issue.project_id || (context.project?.id ?? ""),
        rationale: input.rationale
      };
      const actionContext = actionContextForProposal(context, proposal);
      return createPendingPiAction(db, actionContext, proposal, () => enqueueIssueAndNotify(db, context, input.issue_id));
    },
    requestIssueAcceptanceAction: (input) => requestIssueAcceptanceAction(db, context, input),
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
    readRunnerSettings: () => safeReadRunnerSettings(db, context),
    readSessionSummary: (input) => safeReadSessionSummary(db, context, input),
    restartSystem: (input) => restartSystemProposal(db, context, input),
    updateRunnerSettings: (input) => runnerSettingsUpdateProposal(db, context, input)
  };
}

function cancelIssues(
  db: RunnerDatabase,
  context: PiRunnerActionContext,
  input: IssueCancelInput
) {
  const reason = cleanString(input.rationale) || "用户明确取消 Issue";
  const statusInput: IssueStatusUpdateInput = { issue_ids: input.issue_ids, reason, status: "cancelled" };
  const prepared = prepareIssueStatusUpdate(db, statusInput);
  const projectID = prepared.projectID;
  const actionType = "issue.cancel";
  const actionContext = scopedRunnerChatActionContext(context, actionType, {
    issueIDs: prepared.issues.map((issue) => issue.id),
    projectID
  });
  return createPendingPiAction(db, actionContext, {
    actionType,
    payload: {
      expected_state: issueBatchExpectedState(prepared.issues),
      issue_ids: prepared.issues.map((issue) => issue.id),
      reason,
      status: "cancelled"
    },
    projectID,
    rationale: input.rationale
  }, () => executeIssueStatusUpdate(db, statusInput, issueStatusRuntime(context)));
}

function updateIssueStatuses(
  db: RunnerDatabase,
  context: PiRunnerActionContext,
  input: IssueStatusUpdateInput
) {
  const prepared = prepareIssueStatusUpdate(db, input);
  const actionType = "issue.status_update";
  const actionContext = scopedRunnerChatActionContext(context, actionType, {
    issueIDs: prepared.issues.map((issue) => issue.id),
    projectID: prepared.projectID
  });
  return createPendingPiAction(db, actionContext, {
    actionType,
    payload: {
      ...cleanObjectPayload(input),
      expected_state: issueBatchExpectedState(prepared.issues)
    },
    projectID: prepared.projectID,
    rationale: input.reason
  }, () => executeIssueStatusUpdate(db, input, issueStatusRuntime(context)));
}

function respondToHumanReview(
  db: RunnerDatabase,
  context: PiRunnerActionContext,
  input: HumanReviewResponseInput
) {
  const issue = mustGetIssue(db, input.issue_id);
  const actionType = "human_review.respond";
  const actionContext = scopedRunnerChatActionContext(context, actionType, {
    issueID: issue.id,
    projectID: issue.project_id
  });
  const currentReview = readIssueDecisionProjection(db, issue.id).request;
  const payload = {
    ...cleanObjectPayload(input),
    expected_state: humanReviewExpectedState(issue, currentReview)
  };
  return createPendingPiAction(db, actionContext, {
    actionType,
    issueID: issue.id,
    payload,
    projectID: issue.project_id,
    rationale: cleanString(input.comment) || `human review ${input.action}`
  }, async () => {
    const updated = await reviewHumanIssue(db, issue.id, payload, {
      bus: context.bus,
      providers: context.providers
    });
    return {
      action: input.action,
      decision: readIssueDecisionProjection(db, issue.id),
      issue: {
        id: updated.id,
        project_id: updated.project_id,
        status: updated.status,
        title: updated.title
      }
    };
  });
}

function deleteIssuesProposal(
  db: RunnerDatabase,
  context: PiRunnerActionContext,
  input: IssueDeleteInput
) {
  const issues = explicitIssues(db, input.issue_ids);
  const projectID = singleProjectID(issues.map((issue) => issue.project_id));
  const actionType = "issue.delete";
  const actionContext = scopedRunnerChatActionContext(context, actionType, {
    issueID: issues.length === 1 ? issues[0]?.id : undefined,
    issueIDs: issues.map((issue) => issue.id),
    projectID
  });
  return createPendingPiAction(db, actionContext, {
    actionType,
    issueID: issues.length === 1 ? issues[0]?.id : undefined,
    payload: {
      expected_state: issueBatchExpectedState(issues),
      issue_ids: issues.map((issue) => issue.id),
      reason: input.reason
    },
    projectID,
    rationale: input.reason
  }, () => deleteIssues(db, issues.map((issue) => issue.id)));
}

function safeReadRunnerSettings(db: RunnerDatabase, context: PiRunnerActionContext) {
  return executeSafePiAction(db, context, {
    actionType: "runner.settings_read",
    payload: {},
    execute: () => readRunnerSettings(runnerSettingsContext(db, context))
  });
}

function runnerSettingsUpdateProposal(
  db: RunnerDatabase,
  context: PiRunnerActionContext,
  input: RunnerSettingsUpdateInput
) {
  const payload = cleanObjectPayload(input);
  return createPendingPiAction(db, context, {
    actionType: "runner.settings_update",
    payload,
    rationale: input.reason
  }, () => applyRunnerSettings(runnerSettingsContext(db, context), payload));
}

function restartSystemProposal(
  db: RunnerDatabase,
  context: PiRunnerActionContext,
  input: SystemRestartInput
) {
  return createPendingPiAction(db, context, {
    actionType: "system.restart",
    payload: { reason: input.reason },
    rationale: input.reason
  }, () => {
    const result = scheduleSystemRestart(systemRestartContext(context));
    if (!result) throw new Error("当前服务不是 launchd/systemd 托管，无法安全重启");
    return result;
  });
}

function issueStatusRuntime(context: PiRunnerActionContext) {
  return {
    bus: context.bus,
    onExecutionRequested: context.onIssueEnqueued,
    providers: context.providers
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
  const trustedTarget = context.notificationTarget;
  const enrichedInput = {
    ...input,
    origin_conversation_id: cleanString(input.origin_conversation_id) || cleanString(context.conversationID),
    source_event_id: cleanString(input.source_event_id) || cleanString(context.sourceTurn?.id),
    target_channel: canonicalNotificationConnector(
      trustedTarget?.connectorID || input.target_channel || context.source
    ),
    target_chat_id: cleanString(trustedTarget?.conversationID) || cleanString(input.target_chat_id),
    target_message_id: cleanString(trustedTarget?.replyToMessageID) || cleanString(input.target_message_id),
    target_thread_id: cleanString(trustedTarget?.threadID) || cleanString(input.target_thread_id)
  };
  const projectID = watchProjectID(db, enrichedInput);
  const actionContext = scopedRunnerChatActionContext(context, "issue_completion_watch.create", {
    issueIDs: enrichedInput.issue_ids,
    projectID
  });
  return createPendingPiAction(db, actionContext, {
    actionType: "issue_completion_watch.create",
    payload: cleanObjectPayload({ ...enrichedInput, project_id: projectID }),
    projectID,
    rationale: enrichedInput.note
  }, () => createIssueCompletionWatchAction(db, { ...enrichedInput, project_id: projectID }));
}

function canonicalNotificationConnector(value: unknown): string {
  const connector = cleanString(value).toLowerCase();
  if (connector === "feishu_runner_chat") return "feishu";
  if (connector === "telegram_runner_chat") return "telegram";
  if (connector.endsWith("_runner_chat")) return connector.slice(0, -"_runner_chat".length);
  return connector;
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

function requestIssueAcceptanceAction(
  db: RunnerDatabase,
  context: PiRunnerActionContext,
  input: IssueAcceptanceRequestInput
) {
  const issue = mustGetIssue(db, input.issue_id);
  const actionType = "issue.acceptance_request";
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
    const pending = requestIssuePiAcceptance(db, issue.id, {
      reason: input.rationale,
      source: "pi-issue-completion-reconciliation"
    });
    return {
      issue: {
        id: pending.id,
        project_id: pending.project_id,
        status: pending.status,
        title: pending.title
      },
      target_status: pending.status,
      transition_path: []
    };
  });
}


function safeListIssues(db: RunnerDatabase, context: PiRunnerActionContext, input: IssueListInput) {
  const filter = normalizeIssueFilter(input, context);
  return executeSafePiAction(db, context, {
    actionType: "issue.list",
    payload: cleanObjectPayload({
      limit: input.limit,
      project_id: filter.projectId,
      scope: filter.scope,
      scope_source: filter.scopeSource,
      status: filter.status
    }),
    projectID: filter.projectId,
    execute: () => createCompactIssueList(db, {
      limit: input.limit,
      projectId: filter.projectId,
      scope: filter.scope,
      scopeSource: filter.scopeSource,
      status: filter.status
    })
  });
}

function safeIssueStatusSummary(db: RunnerDatabase, context: PiRunnerActionContext, input: IssueStatusSummaryInput) {
  const filter = normalizeIssueFilter(input, context);
  return executeSafePiAction(db, context, {
    actionType: "issue.status_summary",
    payload: cleanObject({
      project_id: filter.projectId,
      scope: filter.scope,
      scope_source: filter.scopeSource,
      status: filter.status
    }),
    projectID: filter.projectId,
    execute: () => createIssueStatusSummary(db, {
      projectId: filter.projectId,
      scope: filter.scope,
      scopeSource: filter.scopeSource,
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
    execute: () => ({
      ...issue,
      allowed_status_targets: allowedIssueStatusTargets(issue.status),
      decision: readIssueDecisionProjection(db, issue.id),
      dependency: readIssueDependency(db, issue.id),
      execution: createIssueExecutionStatus(db, issue.id),
      source: "issue_read"
    })
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
  const projectID = requiredCreateProjectID(input.project_id);
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

function issueCreateBatchProposal(
  input: IssueCreateBatchProposalInput,
  context: PiRunnerActionContext
): ProposalInput {
  const projectID = requiredCreateProjectID(input.project_id);
  const payload = normalizeIssueBatchPayload({
    project_id: projectID,
    status: "triage",
    batch_items: input.items.map((item) => ({
      ref: item.ref,
      title: item.title ?? "",
      description: renderIssueCreateProposalDescription(item, { project: context.project, projectID }),
      depends_on_refs: item.depends_on_refs ?? [],
      required_skill_intents: parseSkillIntentList(item.required_skill_intents),
      recommended_skill_intents: parseSkillIntentList(item.recommended_skill_intents),
      required_mcp_capabilities: item.required_mcp_capabilities ?? [],
      recommended_mcp_capabilities: item.recommended_mcp_capabilities ?? []
    }))
  });
  return { actionType: "issue.create", payload, projectID, rationale: input.rationale };
}

function sessionSteerProposal(db: RunnerDatabase, input: SessionSteerProposalInput): ProposalInput {
  const session = readSessionSummary(db, input.session_key);
  const progress = observeSessionProgress(db, session.session_key);
  return {
    actionType: "session.steer",
    payload: {
      expected_state: sessionExpectedState(session),
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
    execute: () => ({ items: recommendSkillIntents(input).map(compactSkillRecommendation) })
  });
}

function compactSkillRecommendation(item: ReturnType<typeof recommendSkillIntents>[number]) {
  return {
    allowed_roles: item.allowed_roles,
    description: item.description,
    id: item.id,
    name: item.name,
    reason: item.reason,
    risk_level: item.risk_level,
    score: item.score,
    summary: item.summary,
    version: item.version
  };
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
  const explicitProjectID = cleanString(input.project_id);
  const requestedScope = cleanString(input.scope);
  if (requestedScope !== "" && requestedScope !== "global" && requestedScope !== "project") {
    throw new Error("scope must be global or project");
  }
  if (requestedScope === "global" && explicitProjectID !== "") {
    throw new Error("project_id must be empty when scope is global");
  }
  const defaultScope = context.issueQueryDefaultScope ?? (context.project?.id ? "project" : "global");
  const scope: IssueQueryScope = requestedScope === "global" || requestedScope === "project"
    ? requestedScope
    : explicitProjectID !== "" ? "project" : defaultScope;
  const projectId = scope === "project" ? explicitProjectID || (context.project?.id ?? "") : "";
  if (scope === "project" && projectId === "") throw new ProjectNotFoundError();
  return {
    projectId,
    scope,
    scopeSource: requestedScope !== ""
      ? "explicit_scope"
      : explicitProjectID !== "" ? "explicit_project_id" : "runtime_default",
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

function requiredCreateProjectID(id: unknown): string {
  const projectID = cleanString(id);
  if (projectID === "") {
    throw new Error("issue_create_project_required: 创建 Issue 需要 project_id，但当前工具输入未提供目标 Project 信息");
  }
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

function explicitIssues(db: RunnerDatabase, ids: number[]): Issue[] {
  const uniqueIDs = [...new Set(ids)];
  if (uniqueIDs.length === 0 || uniqueIDs.length > 40) throw new Error("issue_ids must contain 1-40 items");
  return uniqueIDs.map((id) => mustGetIssue(db, id));
}

function singleProjectID(projectIDs: string[]): string {
  const unique = [...new Set(projectIDs.filter(Boolean))];
  if (unique.length !== 1) throw new Error("批量 Issue 操作必须属于同一个项目");
  return unique[0]!;
}

function runnerSettingsContext(db: RunnerDatabase, context: PiRunnerActionContext) {
  return {
    bus: context.bus,
    config: context.config,
    database: db,
    providers: context.providers
  };
}

function systemRestartContext(context: PiRunnerActionContext) {
  return {
    audit: context.auditSystemRestart,
    providers: context.providers,
    restartDelayMs: context.restartDelayMs,
    restartProcess: context.restartProcess,
    supervisorManaged: context.supervisorManaged
  };
}

function readSessionSummary(db: RunnerDatabase, sessionKey: string) {
  const key = cleanString(sessionKey);
  const session = getAgentSessionByReference(db, key);
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
