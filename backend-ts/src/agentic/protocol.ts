import type {
  AgentCommunicationDecision,
  AgentCommunicationDecisionInput
} from "../notifications/agentCommunicationGateway.ts";
import type { IssueSupervisorRecoveryContext } from "../pi/issueSupervisorContext.ts";
import type { PiSupervisorDecisionRuntimeResult } from "../pi/issueSupervisorDecision.ts";
import type { PiAutoManageProjectCycleInput } from "../runner/piAutoManageScheduler.ts";
import type { CompletionCard } from "../domain/acceptance/completionCard.ts";
import type { PiAcceptanceRuntimeResult } from "../pi/issueAcceptance.ts";

export const AGENTIC_HEALTH_PATH = "/health";
export const AGENTIC_PROJECT_CYCLE_PATH = "/api/internal/agentic/project-cycle";
export const AGENTIC_COMMUNICATION_DECISION_PATH = "/api/internal/agentic/communication-decision";
export const AGENTIC_SUPERVISOR_DECISION_PATH = "/api/internal/agentic/supervisor-decision";
export const AGENTIC_ISSUE_ACCEPTANCE_PATH = "/api/internal/agentic/issue-acceptance";

export type AgenticProjectCycleRequest = PiAutoManageProjectCycleInput;
export type AgenticProjectCycleResult = Record<string, unknown>;
export type AgenticCommunicationDecisionRequest = AgentCommunicationDecisionInput;
export type AgenticCommunicationDecisionResult = AgentCommunicationDecision;
export type AgenticSupervisorDecisionRequest = { context: IssueSupervisorRecoveryContext };
export type AgenticSupervisorDecisionResult = PiSupervisorDecisionRuntimeResult;
export type AgenticIssueAcceptanceRequest = { card: CompletionCard };
export type AgenticIssueAcceptanceResult = PiAcceptanceRuntimeResult;

export type AgenticActivitySnapshot = {
  in_flight: number;
  last_activity_at: string;
  worker_pid?: number;
  worker_rss_bytes?: number;
  worker_started_at?: string;
};

export type AgenticWorkerClient = {
  activity(): AgenticActivitySnapshot;
  decideCommunication(input: AgenticCommunicationDecisionRequest): Promise<AgenticCommunicationDecisionResult>;
  decideIssueAcceptance?(card: CompletionCard): Promise<AgenticIssueAcceptanceResult>;
  decideSupervisor(context: IssueSupervisorRecoveryContext): Promise<AgenticSupervisorDecisionResult>;
  health(): Promise<{ ok: boolean; role: "agentic" }>;
  runProjectCycle(input: AgenticProjectCycleRequest): Promise<AgenticProjectCycleResult>;
};

export type AgenticRpcError = { error: string; ok: false };
export type AgenticRpcSuccess<T> = { ok: true; result: T };
export type AgenticRpcResponse<T> = AgenticRpcError | AgenticRpcSuccess<T>;
