import type { RunnerConfig } from "../../config/env.ts";
import { deleteIssues } from "../../db/repositories/issueActions.ts";
import { listProjects, type Project } from "../../db/repositories/projects.ts";
import { type PiMcpActionLayer } from "../mcp/mcpActionTools.ts";
import { type PiActionContext } from "../actions/actionEngine.ts";
import { createIssueStateRepairProposal, type IssueStateDiagnosisInput, type IssueStateRepairProposalInput } from "./runnerIssueStateActions.ts";
import { type IssueScheduleEnqueueInput } from "./runnerIssueScheduleActions.ts";
import { type PiAgentOrchestrationActionLayer } from "../runtime/agentOrchestrationActions.ts";
import { type PiRepoReadActionLayer } from "../tools/repoReadActionTools.ts";
import { type BatchTriageIssueInput, type NextTriageIssueInput } from "./runnerNextTriageActions.ts";
import { type IssueProposalContextFields } from "./issueProposalContext.ts";
import { type IssueCompletionWatchCancelInput, type IssueCompletionWatchCreateInput, type IssueCompletionWatchListInput } from "./issueCompletionWatchActions.ts";
import { type ManualContextIntakeInput } from "../intake/manualTrigger.ts";
import type { ExecutorProvider, ExecutorProviderId } from "../../providers/types.ts";
import type { ProviderCatalogEntry } from "../../providers/core/catalog.ts";
import { type IssueStatusUpdateInput } from "./runnerIssueStatusActions.ts";
import { type CreateHumanReviewRequestInput } from "../../domain/review/humanReview.ts";
import { readRunnerSettings } from "../../http/settings/runnerSettingsApi.ts";
import { type SystemRestartAuditEvent } from "../../http/system/systemRestartApi.ts";
import { cancelIssues, updateIssueStatuses, respondToHumanReview } from "./runnerIssueMutations.ts";
import { requestIssueAcceptanceAction } from "./runnerIssueQueries.ts";
import { readSessionSummary } from "./runnerActionValues.ts";

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

export type IssueQueryScope = "global" | "project";

export type IssueListInput = { limit?: number; project_id?: string; scope?: IssueQueryScope; status?: string };

export type IssueReadInput = { id: number };

export type IssueExecutionStatusInput = { id: number };

export type IssueAcceptanceRequestInput = { issue_id: number; rationale?: string };

export type IssueCommentInput = { body: string; issue_id: number };

export type HumanReviewResponseInput = {
  action: "accept" | "request_changes" | "reject";
  comment?: string;
  issue_id: number;
  review_request_id: string;
  review_revision: number;
};

export type IssueCancelInput = { issue_ids: number[]; rationale?: string };

export type IssueDeleteInput = { issue_ids: number[]; reason: string };

export type IssueProposalInput = { issue_id: number; rationale?: string };

export type IssueCreateProposalInput = IssueProposalContextFields & {
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

export type IssueCreateBatchProposalInput = {
  items: Array<Omit<IssueCreateProposalInput, "project_id"> & { ref: string; depends_on_refs?: string[] }>;
  project_id?: string;
  rationale?: string;
};

export type ProjectListInput = {};

export type SkillListInput = {};

export type SkillReadInput = { id: string };

export type SkillRecommendInput = { description?: string; project_id?: string; title?: string };

export type SkillIntentAuditInput = { issue_id: number; issue_run_id?: string; used_skill_intents?: string[] };

export type IssueStatusSummaryInput = { project_id?: string; scope?: IssueQueryScope; status?: string };

export type ProjectStatusInput = { project_id?: string };

export type SessionListInput = { project_id?: string; provider?: string; role?: string };

export type SessionReadSummaryInput = { session_key: string };

export type SessionSteerProposalInput = { prompt: string; rationale?: string; session_key: string };

export type RunnerSettingsUpdateInput = {
  codex_app_command?: string;
  codex_cli_command?: string;
  codex_server_mode?: "app" | "cli";
  max_parallel_projects?: number;
  reason: string;
};

export type SystemRestartInput = { reason: string };

export type ProposalInput = {
  actionType: string;
  issueID?: number;
  payload: Record<string, unknown>;
  projectID?: string;
  rationale?: string;
};
