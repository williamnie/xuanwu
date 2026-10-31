import type { RunnerDatabase } from "../db/database.ts";
import type { RunnerConfig } from "../config/env.ts";
import type { EventBus } from "../events/bus.ts";
import type { ExecutorProvider, ExecutorProviderId } from "../providers/types.ts";
import { type DailyDigestResult } from "../notifications/dailyDigest.ts";
import { type AgentCommunicationDecider, type AgentCommunicationGatewayResult } from "../notifications/agentCommunicationGateway.ts";
import type { GuardianAlertDelivery } from "../pi/guardian/guardianAlertDelivery.ts";
import { type GuardianMissedIntentSweepResult } from "../pi/guardian/guardianMissedIntentSweep.ts";
import { type GuardianDecisionOrchestratorSummary } from "../pi/guardian/guardianDecisionOrchestrator.ts";
import { type PiGuardianActionDispatchResult } from "./piGuardianActionDispatcher.ts";
import { type PiGuardianWatchdogSummary } from "../pi/guardian/guardianWatchdog.ts";
import { type GuardianOperationsDailyReportResult } from "../pi/guardian/guardianOperationsDailyReport.ts";
import { type PiIssueSupervisorSchedulerInput } from "./piIssueSupervisorScheduler.ts";
import { type PiIssueAcceptanceRunner, type PiAcceptanceCoordinatorResult } from "./piAcceptanceCoordinator.ts";
import { type AutomationExecutor, type AutomationSchedulerResult } from "./automationScheduler.ts";
import type { ImChannelRegistry } from "../integrations/im/imChannelContracts.ts";
import { type ProviderTerminalBackfillSummary } from "./providerTerminalSignals.ts";
import { type IssueWatchdogSummary } from "./issueWatchdog.ts";

export type PiAutoManageProjectCycleInput = { maxActions?: number; projectId: string };

export type PiAutoManageProjectCycle = (input: PiAutoManageProjectCycleInput) => Promise<unknown>;

export type PiAutoManageCycleResult = { projects: number; skipped: number; started: number };

export type ScheduleTiming = {
  cycle_id: string;
  cycle_kind: "agentic" | "guardian" | "legacy";
  duration_ms: number;
  operation_ms: number;
  phase: string;
  post_yield_ms: number;
  queue_wait_ms: number;
  result?: Record<string, number>;
  started_at: string;
  status: "failed" | "succeeded";
};

export type ScheduleLayerCycleResult = PiAutoManageCycleResult & {
  agentCommunications: AgentCommunicationGatewayResult;
  automationCore: AutomationSchedulerResult;
  automations: { executed: number; failed: number; scanned: number; skipped: number };
  cron: { executed: number; failed: number; scanned: number; skipped: number };
  delegations: { scanned: number; skipped: number; started: number };
  digestFlush: { flushed: number; scanned: number; skipped: number };
  digestNotifications: { failed: number; queued: number; scanned: number; skipped: number };
  dailyDigestNotifications: DailyDigestResult;
  completionWatchNotifications: { failed: number; queued: number; scanned: number; skipped: number };
  guardianActionDispatch: PiGuardianActionDispatchResult;
  missedIntentSweep: GuardianMissedIntentSweepResult;
  guardianDecisions: GuardianDecisionOrchestratorSummary;
  providerTerminalSignals: ProviderTerminalBackfillSummary;
  supervisor: { decisions: number; failed: number; scanned: number; signaled: number; skipped: number };
  issueWatchdog: IssueWatchdogSummary;
  operationsDailyReports: GuardianOperationsDailyReportResult;
  watchdog: PiGuardianWatchdogSummary;
};

export type GuardianControlPlaneCycleResult = Pick<ScheduleLayerCycleResult,
  "automationCore" | "automations" | "completionWatchNotifications" | "cron" |
  "dailyDigestNotifications" | "delegations" | "digestFlush" | "digestNotifications" |
  "guardianActionDispatch" | "guardianDecisions" | "issueWatchdog" | "missedIntentSweep" |
  "operationsDailyReports" | "providerTerminalSignals" | "watchdog"
>;

export type AgenticCycleResult = PiAutoManageCycleResult & Pick<ScheduleLayerCycleResult,
  "agentCommunications" | "supervisor"
> & { acceptance: PiAcceptanceCoordinatorResult };

export type PiAutoManageCycleInput = {
  agentCommunicationDecider?: AgentCommunicationDecider;
  bus?: EventBus;
  codexSessionsDir?: string;
  config?: RunnerConfig;
  database: RunnerDatabase;
  decideIssueAcceptance?: PiIssueAcceptanceRunner;
  guardianAlertDelivery?: GuardianAlertDelivery;
  imChannels?: ImChannelRegistry;
  providers?: Partial<Record<ExecutorProviderId, ExecutorProvider>>;
  runAutomationCore?: AutomationExecutor;
  runProjectCycle: PiAutoManageProjectCycle;
  runSupervisor?: boolean;
  runSupervisorDecision?: PiIssueSupervisorSchedulerInput["runDecision"];
  scheduleTimingObserver?: (timing: ScheduleTiming) => void;
  watchdogNow?: Date | string;
  watchdogStaleAfterMs?: number;
};

export type PiAutoManageSchedulerClock<Timer = unknown> = {
  clearTimeout(timer: Timer): void;
  setTimeout(callback: () => void | Promise<void>, delayMs: number): Timer;
};

export type PiAutoManageSchedulerInput<Timer = unknown> = PiAutoManageCycleInput & {
  clock?: PiAutoManageSchedulerClock<Timer>;
  initialDelayMs?: number;
  intervalMs?: number;
  onError?: (error: unknown) => void;
  supervisorIntervalMs?: number;
  runWithinActivity?: (operation: () => Promise<unknown>) => Promise<unknown>;
};

export type PiAutoManageScheduler = {
  start(): void;
  stop(): void;
};

export type EnabledProjectRow = { project_id: string };

export const DEFAULT_INTERVAL_MS = 30_000;

export const DEFAULT_SUPERVISOR_INTERVAL_MS = 60_000;

export const AGENTIC_INITIAL_DELAY_MS = 15_000;

// The watchdog heartbeat goes stale while the service is down; refresh it on boot
// instead of showing a stale banner until the first 30s tick.
export const GUARDIAN_INITIAL_DELAY_MS = 0;
