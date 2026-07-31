import type { RunnerDatabase } from "../db/database.ts";
import type { RunnerConfig } from "../config/env.ts";
import { isPiHeartbeatPaused } from "../db/repositories/pi.ts";
import type { EventBus } from "../events/bus.ts";
import { queueReadyFeishuDigestNotifications } from "../integrations/feishuLifecycleNotifications.ts";
import { queuePendingPiActionNotifications } from "../integrations/feishuNotifications.ts";
import type { PiGuardianDirectFeishuOptions } from "../integrations/feishuGuardianAlerts.ts";
import type { FeishuMessageClient } from "../integrations/feishuClient.ts";
import { createFeishuMessageClient } from "../integrations/feishuClient.ts";
import type { ExecutorProvider, ExecutorProviderId } from "../providers/types.ts";
import { runDigestFlushSchedulerOnce } from "../pi/digestFlushScheduler.ts";
import { queueDailyNotificationDigests, type DailyDigestResult } from "../notifications/dailyDigest.ts";
import {
  runAgentCommunicationGatewayOnce,
  type AgentCommunicationDecider,
  type AgentCommunicationGatewayResult
} from "../notifications/agentCommunicationGateway.ts";
import { sendMissedDigestPendingFeishuFallback } from "../pi/guardianMissedDigestFallback.ts";
import {
  runGuardianMissedIntentSweepOnce,
  type GuardianMissedIntentSweepResult
} from "../pi/guardianMissedIntentSweep.ts";
import {
  drainGuardianDecisionOrchestrator,
  type GuardianDecisionOrchestratorSummary
} from "../pi/guardianDecisionOrchestrator.ts";
import {
  dispatchApprovedGuardianActions,
  type PiGuardianActionDispatchResult
} from "./piGuardianActionDispatcher.ts";
import {
  runPiGuardianWatchdogOnce,
  type PiGuardianWatchdogSummary
} from "../pi/guardianWatchdog.ts";
import { resolveRecoveredAlerts } from "../pi/guardianWatchdogMaintenance.ts";
import {
  queueGuardianOperationsDailyReports,
  type GuardianOperationsDailyReportResult
} from "../pi/guardianOperationsDailyReport.ts";
import {
  runPiIssueSupervisorSchedulerOnce,
  type PiIssueSupervisorSchedulerInput
} from "./piIssueSupervisorScheduler.ts";
import {
  runPiVerificationCoordinatorOnce,
  type PiIssueAcceptanceRunner,
  type PiVerificationCoordinatorResult
} from "./piVerificationCoordinator.ts";
import {
  runDueAutomations,
  type AutomationExecutor,
  type AutomationSchedulerResult
} from "./automationScheduler.ts";
import { createNativeAutomationExecutor } from "./automationRuntime.ts";
import { runWatchAutomationsOnce } from "./watchAutomationRuntime.ts";
import { dispatchFeishuOutbox } from "../pi/imReplyOutboxDispatcher.ts";
import {
  signalOpenRunTerminalProviderErrors,
  type ProviderTerminalBackfillSummary
} from "./providerTerminalSignals.ts";
import {
  runAutoRunIssueWatchdogOnce,
  type IssueWatchdogSummary
} from "./issueWatchdog.ts";

export type PiAutoManageProjectCycleInput = { maxActions?: number; projectId: string };
export type PiAutoManageProjectCycle = (input: PiAutoManageProjectCycleInput) => Promise<unknown>;
export type PiAutoManageCycleResult = { projects: number; skipped: number; started: number };
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
> & { verification: PiVerificationCoordinatorResult };

export type PiAutoManageCycleInput = {
  agentCommunicationDecider?: AgentCommunicationDecider;
  bus?: EventBus;
  codexSessionsDir?: string;
  config?: RunnerConfig;
  database: RunnerDatabase;
  decideIssueAcceptance?: PiIssueAcceptanceRunner;
  guardianDirectFeishuSender?: FeishuMessageClient;
  providers?: Partial<Record<ExecutorProviderId, ExecutorProvider>>;
  runAutomationCore?: AutomationExecutor;
  runProjectCycle: PiAutoManageProjectCycle;
  runSupervisor?: boolean;
  runSupervisorDecision?: PiIssueSupervisorSchedulerInput["runDecision"];
  watchdogNow?: Date | string;
  watchdogStaleAfterMs?: number;
};

export type PiAutoManageSchedulerClock<Timer = unknown> = {
  clearTimeout(timer: Timer): void;
  setTimeout(callback: () => void | Promise<void>, delayMs: number): Timer;
};

export type PiAutoManageSchedulerInput<Timer = unknown> = PiAutoManageCycleInput & {
  clock?: PiAutoManageSchedulerClock<Timer>;
  intervalMs?: number;
  onError?: (error: unknown) => void;
  supervisorIntervalMs?: number;
  runWithinActivity?: (operation: () => Promise<unknown>) => Promise<unknown>;
};

export type PiAutoManageScheduler = {
  start(): void;
  stop(): void;
};

type EnabledProjectRow = { project_id: string };

const DEFAULT_INTERVAL_MS = 30_000;
const DEFAULT_SUPERVISOR_INTERVAL_MS = 60_000;
const activeProjectCycles = new Set<string>();

export function createPiAutoManageScheduler<Timer = unknown>(
  input: PiAutoManageSchedulerInput<Timer>
): PiAutoManageScheduler {
  const runtimeInput = withNativeAutomationExecutor(input);
  const supervisorIntervalMs = input.supervisorIntervalMs ?? DEFAULT_SUPERVISOR_INTERVAL_MS;
  let lastSupervisorScanAt = 0;
  return createCycleScheduler(input, async () => {
    const now = Date.now();
    const runSupervisor = shouldRunSupervisor(now, lastSupervisorScanAt, supervisorIntervalMs);
    if (runSupervisor) lastSupervisorScanAt = now;
    await runScheduleLayerCycle({ ...runtimeInput, runSupervisor });
  });
}

export function createPiGuardianScheduler<Timer = unknown>(
  input: PiAutoManageSchedulerInput<Timer>
): PiAutoManageScheduler {
  const runtimeInput = withNativeAutomationExecutor(input);
  return createCycleScheduler(input, () => runGuardianControlPlaneCycle(runtimeInput));
}

export function createPiAgenticScheduler<Timer = unknown>(
  input: PiAutoManageSchedulerInput<Timer>
): PiAutoManageScheduler {
  const supervisorIntervalMs = input.supervisorIntervalMs ?? DEFAULT_SUPERVISOR_INTERVAL_MS;
  let lastSupervisorScanAt = 0;
  return createCycleScheduler(input, async () => {
    const now = Date.now();
    const runSupervisor = shouldRunSupervisor(now, lastSupervisorScanAt, supervisorIntervalMs);
    if (runSupervisor) lastSupervisorScanAt = now;
    await runAgenticCycle({ ...input, runSupervisor });
  });
}

export async function runPiAutoManageCycle(input: PiAutoManageCycleInput): Promise<PiAutoManageCycleResult> {
  const projects = listAutoManagedProjects(input.database);
  const result: PiAutoManageCycleResult = { projects: projects.length, skipped: 0, started: 0 };
  for (const project of projects) {
    if (isProjectHeartbeatPaused(input.database, project.project_id)) {
      result.skipped += 1;
      continue;
    }
    if (activeProjectCycles.has(project.project_id)) {
      result.skipped += 1;
      continue;
    }
    await runManagedProjectCycle(input.runProjectCycle, project);
    result.started += 1;
  }
  return result;
}

export async function runScheduleLayerCycle(input: PiAutoManageCycleInput): Promise<ScheduleLayerCycleResult> {
  const cycleStartedAt = performance.now();
  const guardian = await runGuardianControlPlaneCycle(input);
  const agentic = await runAgenticCycle(input);
  const cycleDurationMs = performance.now() - cycleStartedAt;
  if (cycleDurationMs >= SLOW_SCHEDULE_PHASE_MS) logScheduleTiming("cycle", cycleDurationMs);
  return { ...guardian, ...agentic };
}

export async function runGuardianControlPlaneCycle(
  input: PiAutoManageCycleInput
): Promise<GuardianControlPlaneCycleResult> {
  const cycleStartedAt = performance.now();
  // W3 target-only cutover: compatibility result fields stay stable for one
  // release, but legacy Cron/PI/delegation schedulers are no longer invoked.
  const cron = { executed: 0, failed: 0, scanned: 0, skipped: 0 };
  const automations = { executed: 0, failed: 0, scanned: 0, skipped: 0 };
  const automationCore = await timedSchedulePhase("automation_core", () => runDueAutomations({
    database: input.database,
    executeAutomation: input.runAutomationCore ?? createNativeAutomationExecutor(input),
    now: optionalDate(input.watchdogNow)
  }));
  const delegations = { scanned: 0, skipped: 0, started: 0 };
  const providerTerminalSignals = await timedSchedulePhase(
    "provider_terminal_signals",
    () => signalOpenRunTerminalProviderErrors(input.database)
  );
  const guardianDecisions = await timedSchedulePhase(
    "guardian_decisions",
    () => drainGuardianDecisionOrchestrator(input.database)
  );
  const guardianActionDispatch = await timedSchedulePhase("guardian_action_dispatch", () => dispatchApprovedGuardianActions({
    bus: input.bus,
    database: input.database,
    providers: input.providers
  }));
  const digestFlush = await timedSchedulePhase("digest_flush", () => runDigestFlushSchedulerOnce(input.database));
  const directFeishu = guardianDirectFeishuOptions(input);
  const watchdog = await timedSchedulePhase("guardian_watchdog", () => runPiGuardianWatchdogOnce(input.database, {
    directFeishu,
    now: input.watchdogNow,
    staleAfterMs: input.watchdogStaleAfterMs
  }));
  const missedIntentSweep = await timedSchedulePhase(
    "missed_intent_sweep",
    () => runMissedIntentSweepWithFallback(input, watchdog, directFeishu)
  );
  await timedSchedulePhase("resolve_recovered_alerts", () => (
    resolveRecoveredAlerts(input.database, watchdog.checks, cycleNowText(input.watchdogNow))
  ));
  const operationsDailyReports = await timedSchedulePhase("operations_daily_reports", () => queueGuardianOperationsDailyReports(input.database, {
    now: optionalDate(input.watchdogNow)
  }));
  const watchResult = await timedSchedulePhase(
    "watch_automations",
    () => runWatchAutomationsOnce(input.database, { now: input.watchdogNow })
  );
  const watchFeishuConfig = input.config;
  if (watchResult.queued > 0 && watchFeishuConfig) {
    await timedSchedulePhase("watch_feishu_outbox", () => dispatchFeishuOutbox({
      config: watchFeishuConfig.integrations.feishu,
      database: input.database,
      now: optionalDate(input.watchdogNow),
      sender: input.guardianDirectFeishuSender ?? createFeishuMessageClient({ config: watchFeishuConfig.integrations.feishu })
    }));
  }
  const dailyDigestNotifications = await timedSchedulePhase(
    "daily_digest_notifications",
    () => queueDailyNotificationDigests(input.database, { now: optionalDate(input.watchdogNow) })
  );
  const digestNotifications = await timedSchedulePhase(
    "digest_notifications",
    () => queueReadyFeishuDigestNotifications(input.database)
  );
  const completionWatchNotifications = { failed: 0, queued: 0, scanned: 0, skipped: 0 };
  const issueWatchdog = await timedSchedulePhase("issue_watchdog", () => runAutoRunIssueWatchdogOnce({
    bus: input.bus,
    database: input.database,
    now: input.watchdogNow,
    providers: input.providers,
    staleAfterMs: input.watchdogStaleAfterMs
  }));
  const cycleDurationMs = performance.now() - cycleStartedAt;
  if (cycleDurationMs >= SLOW_SCHEDULE_PHASE_MS) logScheduleTiming("guardian_cycle", cycleDurationMs);
  return {
    automationCore,
    automations,
    completionWatchNotifications,
    cron,
    dailyDigestNotifications,
    delegations: { scanned: delegations.scanned, skipped: delegations.skipped, started: delegations.started },
    digestFlush,
    digestNotifications,
    guardianActionDispatch,
    guardianDecisions,
    issueWatchdog,
    missedIntentSweep,
    operationsDailyReports,
    providerTerminalSignals,
    watchdog
  };
}

export async function runAgenticCycle(input: PiAutoManageCycleInput): Promise<AgenticCycleResult> {
  const cycleStartedAt = performance.now();
  // Ordinary project manager cycles remain explicit. PI-owned acceptance is
  // different: entering pending_verification is a durable request for one
  // issue-scoped semantic decision over a bounded completion card.
  const verification = input.decideIssueAcceptance
    ? await timedSchedulePhase("pi_verification", () => (
      runPiVerificationCoordinatorOnce({
        bus: input.bus,
        database: input.database,
        decideIssueAcceptance: input.decideIssueAcceptance!,
        providers: input.providers,
        source: "agentic-scheduler"
      })
    ))
    : { failed: 0, issues: 0, projects: 0, skipped: 0, started: 0 };
  const projects: PiAutoManageCycleResult = {
    projects: verification.projects,
    skipped: verification.skipped,
    started: verification.started
  };
  if (input.config) {
    await timedSchedulePhase("pending_action_notifications", () => queuePendingPiActionNotifications(
      input.database,
      input.config?.integrations.feishu
    ));
  }
  const agentCommunications = await timedSchedulePhase("agent_communications", () => runAgentCommunicationGatewayOnce(input.database, {
    decide: input.agentCommunicationDecider,
    now: optionalDate(input.watchdogNow)
  }));
  const communicationFeishuConfig = input.config;
  if ((agentCommunications.queued > 0 || agentCommunications.fallback > 0) && communicationFeishuConfig) {
    await timedSchedulePhase("communication_feishu_outbox", () => dispatchFeishuOutbox({
      config: communicationFeishuConfig.integrations.feishu,
      database: input.database,
      now: optionalDate(input.watchdogNow),
      sender: input.guardianDirectFeishuSender ?? createFeishuMessageClient({ config: communicationFeishuConfig.integrations.feishu })
    }));
  }
  // PI decisions can take tens of seconds. Runtime wiring executes this whole
  // agentic cycle independently from the Guardian/control-plane scheduler.
  const supervisor = input.runSupervisor === false
    ? { decisions: 0, failed: 0, scanned: 0, signaled: 0, skipped: 0 }
    : await timedSchedulePhase("supervisor", () => runPiIssueSupervisorSchedulerOnce({
      bus: input.bus,
      database: input.database,
      now: optionalDate(input.watchdogNow),
      providers: input.providers,
      runDecision: input.runSupervisorDecision
    }));
  const cycleDurationMs = performance.now() - cycleStartedAt;
  if (cycleDurationMs >= SLOW_SCHEDULE_PHASE_MS) logScheduleTiming("agentic_cycle", cycleDurationMs);
  return {
    ...projects,
    agentCommunications,
    supervisor,
    verification
  };
}

const SLOW_SCHEDULE_PHASE_MS = 250;

async function timedSchedulePhase<T>(phase: string, operation: () => T | Promise<T>): Promise<T> {
  // A maintenance cycle contains many synchronous SQLite projections. Yield
  // between them so the HTTP control plane cannot be starved by the scheduler.
  await Bun.sleep(0);
  const startedAt = performance.now();
  try {
    return await operation();
  } finally {
    const durationMs = performance.now() - startedAt;
    if (durationMs >= SLOW_SCHEDULE_PHASE_MS) logScheduleTiming(phase, durationMs);
    await Bun.sleep(0);
  }
}

function logScheduleTiming(phase: string, durationMs: number): void {
  console.warn(JSON.stringify({
    event: "runner.schedule_phase_slow",
    duration_ms: Math.round(durationMs),
    phase
  }));
}

function createCycleScheduler<Timer>(
  input: PiAutoManageSchedulerInput<Timer>,
  cycle: () => Promise<unknown>
): PiAutoManageScheduler {
  const clock = input.clock ?? defaultClock<Timer>();
  const intervalMs = input.intervalMs ?? DEFAULT_INTERVAL_MS;
  let timer: Timer | undefined;
  let stopped = true;
  const schedule = () => { timer = clock.setTimeout(tick, intervalMs); };
  const tick = async () => {
    try {
      await (input.runWithinActivity ? input.runWithinActivity(cycle) : cycle());
    } catch (error) {
      input.onError?.(error);
    } finally {
      if (!stopped) schedule();
    }
  };
  return {
    start() {
      if (!stopped) return;
      stopped = false;
      schedule();
    },
    stop() {
      stopped = true;
      if (timer !== undefined) clock.clearTimeout(timer);
      timer = undefined;
    }
  };
}

function withNativeAutomationExecutor<T extends PiAutoManageCycleInput>(input: T): T {
  if (input.runAutomationCore) return input;
  return { ...input, runAutomationCore: createNativeAutomationExecutor(input) };
}

function shouldRunSupervisor(now: number, lastAt: number, intervalMs: number): boolean {
  return lastAt === 0 || now - lastAt >= intervalMs;
}

export function isProjectHeartbeatPaused(db: RunnerDatabase, projectID: string): boolean {
  return isPiHeartbeatPaused(db, { scopeId: projectID, scopeType: "project" });
}

function listAutoManagedProjects(db: RunnerDatabase): EnabledProjectRow[] {
  return db.sqlite.query<EnabledProjectRow, []>(`
    select s.project_id
    from project_pi_settings s
    join projects p on p.id = s.project_id
    join pi_agents a on a.id = 'runner-default' and a.enabled = 1
    order by p.sort_order asc, p.created_at asc, p.id asc
  `).all();
}

async function runManagedProjectCycle(runProjectCycle: PiAutoManageProjectCycle, project: EnabledProjectRow): Promise<void> {
  activeProjectCycles.add(project.project_id);
  try {
    await runProjectCycle({ projectId: project.project_id });
  } finally {
    activeProjectCycles.delete(project.project_id);
  }
}

function defaultClock<Timer>(): PiAutoManageSchedulerClock<Timer> {
  return {
    clearTimeout: (timer) => clearTimeout(timer as Timer & ReturnType<typeof setTimeout>),
    setTimeout: (callback, delayMs) => setTimeout(() => { void callback(); }, delayMs) as Timer
  };
}

async function runMissedIntentSweepWithFallback(
  input: PiAutoManageCycleInput,
  watchdog: PiGuardianWatchdogSummary,
  directFeishu: PiGuardianDirectFeishuOptions | undefined
): Promise<GuardianMissedIntentSweepResult> {
  const result = runGuardianMissedIntentSweepOnce(input.database, { now: input.watchdogNow, watchdog });
  await sendMissedDigestPendingFeishuFallback(input.database, result.pendingAlertIds, directFeishu);
  return result;
}

function guardianDirectFeishuOptions(input: PiAutoManageCycleInput): PiGuardianDirectFeishuOptions | undefined {
  if (!input.config) return undefined;
  return {
    config: input.config.integrations.feishu,
    now: optionalDate(input.watchdogNow),
    sender: input.guardianDirectFeishuSender
  };
}

function optionalDate(value: Date | string | undefined): Date | undefined {
  if (value instanceof Date) return value;
  return typeof value === "string" && value.trim() !== "" ? new Date(value) : undefined;
}

function cycleNowText(value: Date | string | undefined): string {
  if (value instanceof Date) return value.toISOString().replace(/\.\d{3}Z$/, "Z");
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}
