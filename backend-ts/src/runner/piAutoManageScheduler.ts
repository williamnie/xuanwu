import type { RunnerDatabase } from "../db/database.ts";
import type { RunnerConfig } from "../config/env.ts";
import { isPiHeartbeatPaused } from "../db/repositories/pi.ts";
import type { EventBus } from "../events/bus.ts";
import type { ExecutorProvider, ExecutorProviderId } from "../providers/types.ts";
import { runDigestFlushSchedulerOnce } from "../pi/digestFlushScheduler.ts";
import { queueReadyImDigestNotifications } from "../pi/digestNotifications.ts";
import { queuePendingImActionNotifications } from "../pi/pendingActionNotifications.ts";
import { queueDailyNotificationDigests, type DailyDigestResult } from "../notifications/dailyDigest.ts";
import {
  runAgentCommunicationGatewayOnce,
  type AgentCommunicationDecider,
  type AgentCommunicationGatewayResult
} from "../notifications/agentCommunicationGateway.ts";
import { sendMissedDigestPendingFallback } from "../pi/guardianMissedDigestFallback.ts";
import type { GuardianAlertDelivery } from "../pi/guardianAlertDelivery.ts";
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
  runPiAcceptanceCoordinatorOnce,
  type PiIssueAcceptanceRunner,
  type PiAcceptanceCoordinatorResult
} from "./piAcceptanceCoordinator.ts";
import {
  runDueAutomations,
  type AutomationExecutor,
  type AutomationSchedulerResult
} from "./automationScheduler.ts";
import { createNativeAutomationExecutor } from "./automationRuntime.ts";
import { runWatchAutomationsOnce } from "./watchAutomationRuntime.ts";
import type { ImChannelRegistry } from "../integrations/imChannelContracts.ts";
import { dispatchImOutbox } from "../pi/imReplyOutboxDispatcher.ts";
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

type EnabledProjectRow = { project_id: string };

const DEFAULT_INTERVAL_MS = 30_000;
const DEFAULT_SUPERVISOR_INTERVAL_MS = 60_000;
export const AGENTIC_INITIAL_DELAY_MS = 15_000;
const activeProjectCycles = new Set<string>();
let scheduleCycleSequence = 0;

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
  const timing = scheduleCycleTiming(input, "legacy");
  const guardian = await runGuardianControlPlaneCycle(input);
  const agentic = await runAgenticCycle(input);
  const cycleDurationMs = performance.now() - cycleStartedAt;
  if (cycleDurationMs >= SLOW_SCHEDULE_PHASE_MS) logCycleTiming(timing, "cycle", cycleDurationMs);
  return { ...guardian, ...agentic };
}

export async function runGuardianControlPlaneCycle(
  input: PiAutoManageCycleInput
): Promise<GuardianControlPlaneCycleResult> {
  const cycleStartedAt = performance.now();
  const timing = scheduleCycleTiming(input, "guardian");
  // W3 target-only cutover: compatibility result fields stay stable for one
  // release, but legacy Cron/PI/delegation schedulers are no longer invoked.
  const cron = { executed: 0, failed: 0, scanned: 0, skipped: 0 };
  const automations = { executed: 0, failed: 0, scanned: 0, skipped: 0 };
  const automationCore = await timedSchedulePhase(timing, "automation_core", () => runDueAutomations({
    database: input.database,
    executeAutomation: input.runAutomationCore ?? createNativeAutomationExecutor(input),
    now: optionalDate(input.watchdogNow)
  }));
  const delegations = { scanned: 0, skipped: 0, started: 0 };
  const providerTerminalSignals = await timedSchedulePhase(timing,
    "provider_terminal_signals",
    () => signalOpenRunTerminalProviderErrors(input.database)
  );
  const guardianDecisions = await timedSchedulePhase(timing,
    "guardian_decisions",
    () => drainGuardianDecisionOrchestrator(input.database)
  );
  const guardianActionDispatch = await timedSchedulePhase(timing, "guardian_action_dispatch", () => dispatchApprovedGuardianActions({
    bus: input.bus,
    database: input.database,
    providers: input.providers
  }));
  const digestFlush = await timedSchedulePhase(timing, "digest_flush", () => runDigestFlushSchedulerOnce(input.database));
  const watchdog = await timedSchedulePhase(timing, "guardian_watchdog", () => runPiGuardianWatchdogOnce(input.database, {
    delivery: input.guardianAlertDelivery,
    now: input.watchdogNow,
    staleAfterMs: input.watchdogStaleAfterMs
  }));
  const missedIntentSweep = await timedSchedulePhase(timing,
    "missed_intent_sweep",
    () => runMissedIntentSweepWithFallback(input, watchdog, input.guardianAlertDelivery)
  );
  await timedSchedulePhase(timing, "resolve_recovered_alerts", () => (
    resolveRecoveredAlerts(input.database, watchdog.checks, cycleNowText(input.watchdogNow))
  ));
  const operationsDailyReports = await timedSchedulePhase(timing, "operations_daily_reports", () => queueGuardianOperationsDailyReports(input.database, {
    now: optionalDate(input.watchdogNow)
  }));
  await timedSchedulePhase(timing,
    "watch_automations",
    () => runWatchAutomationsOnce(input.database, { now: input.watchdogNow })
  );
  const dailyDigestNotifications = await timedSchedulePhase(timing,
    "daily_digest_notifications",
    () => queueDailyNotificationDigests(input.database, { now: optionalDate(input.watchdogNow) })
  );
  const digestNotifications = await timedSchedulePhase(timing,
    "digest_notifications",
    () => queueReadyImDigestNotifications(input.database)
  );
  if (input.imChannels) {
    await timedSchedulePhase(timing, "notification_im_outbox", () => dispatchSchedulerImOutbox(input));
  }
  const completionWatchNotifications = { failed: 0, queued: 0, scanned: 0, skipped: 0 };
  const issueWatchdog = await timedSchedulePhase(timing, "issue_watchdog", () => runAutoRunIssueWatchdogOnce({
    bus: input.bus,
    database: input.database,
    now: input.watchdogNow,
    providers: input.providers,
    staleAfterMs: input.watchdogStaleAfterMs
  }));
  const cycleDurationMs = performance.now() - cycleStartedAt;
  if (cycleDurationMs >= SLOW_SCHEDULE_PHASE_MS) logCycleTiming(timing, "guardian_cycle", cycleDurationMs);
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
  const timing = scheduleCycleTiming(input, "agentic");
  // Ordinary project manager cycles remain explicit. PI-owned acceptance is
  // different: an ended Run plus issue.pi_acceptance_requested.v1 is a durable
  // request for one issue-scoped semantic decision over the Provider Session.
  const acceptance = input.decideIssueAcceptance
    ? await timedSchedulePhase(timing, "pi_acceptance", () => (
      runPiAcceptanceCoordinatorOnce({
        bus: input.bus,
        database: input.database,
        decideIssueAcceptance: input.decideIssueAcceptance!,
        providers: input.providers,
        source: "agentic-scheduler"
      })
    ))
    : { failed: 0, issues: 0, projects: 0, skipped: 0, started: 0 };
  const projects: PiAutoManageCycleResult = {
    projects: acceptance.projects,
    skipped: acceptance.skipped,
    started: acceptance.started
  };
  await timedSchedulePhase(timing, "pending_action_notifications", () => queuePendingImActionNotifications(input.database));
  const agentCommunications = await timedSchedulePhase(timing, "agent_communications", () => runAgentCommunicationGatewayOnce(input.database, {
    decide: input.agentCommunicationDecider,
    now: optionalDate(input.watchdogNow)
  }));
  if (input.imChannels) {
    await timedSchedulePhase(timing, "communication_im_outbox", () => dispatchSchedulerImOutbox(input));
  }
  // PI decisions can take tens of seconds. Runtime wiring executes this whole
  // agentic cycle independently from the Guardian/control-plane scheduler.
  const supervisor = input.runSupervisor === false
    ? { decisions: 0, failed: 0, scanned: 0, signaled: 0, skipped: 0 }
    : await timedSchedulePhase(timing, "supervisor", () => runPiIssueSupervisorSchedulerOnce({
      bus: input.bus,
      database: input.database,
      now: optionalDate(input.watchdogNow),
      providers: input.providers,
      runDecision: input.runSupervisorDecision
    }));
  const cycleDurationMs = performance.now() - cycleStartedAt;
  if (cycleDurationMs >= SLOW_SCHEDULE_PHASE_MS) logCycleTiming(timing, "agentic_cycle", cycleDurationMs);
  return {
    ...projects,
    agentCommunications,
    supervisor,
    acceptance
  };
}

const SLOW_SCHEDULE_PHASE_MS = 250;

type ScheduleCycleTiming = {
  cycleID: string;
  input: PiAutoManageCycleInput;
  kind: ScheduleTiming["cycle_kind"];
  startedAt: string;
};

async function timedSchedulePhase<T>(
  cycle: ScheduleCycleTiming,
  phase: string,
  operation: () => T | Promise<T>
): Promise<T> {
  // A maintenance cycle contains many synchronous SQLite projections. Yield
  const queuedAt = performance.now();
  await Bun.sleep(0);
  const startedAt = performance.now();
  let result: T | undefined;
  let status: ScheduleTiming["status"] = "succeeded";
  try {
    result = await operation();
    return result;
  } catch (error) {
    status = "failed";
    throw error;
  } finally {
    const operationMs = performance.now() - startedAt;
    const postYieldStartedAt = performance.now();
    await Bun.sleep(0);
    const finishedAt = performance.now();
    const summary = resultSummary(result);
    const timing: ScheduleTiming = {
      cycle_id: cycle.cycleID,
      cycle_kind: cycle.kind,
      duration_ms: finishedAt - queuedAt,
      operation_ms: operationMs,
      phase,
      post_yield_ms: finishedAt - postYieldStartedAt,
      queue_wait_ms: startedAt - queuedAt,
      ...(summary ? { result: summary } : {}),
      started_at: cycle.startedAt,
      status
    };
    cycle.input.scheduleTimingObserver?.(timing);
    if (timing.duration_ms >= SLOW_SCHEDULE_PHASE_MS) logScheduleTiming(timing);
  }
}

function logScheduleTiming(timing: ScheduleTiming): void {
  console.warn(JSON.stringify({
    event: "runner.schedule_phase_slow",
    ...roundedTiming(timing)
  }));
}

function logCycleTiming(cycle: ScheduleCycleTiming, phase: string, durationMs: number): void {
  const timing: ScheduleTiming = {
    cycle_id: cycle.cycleID,
    cycle_kind: cycle.kind,
    duration_ms: durationMs,
    operation_ms: durationMs,
    phase,
    post_yield_ms: 0,
    queue_wait_ms: 0,
    started_at: cycle.startedAt,
    status: "succeeded"
  };
  cycle.input.scheduleTimingObserver?.(timing);
  logScheduleTiming(timing);
}

function scheduleCycleTiming(input: PiAutoManageCycleInput, kind: ScheduleTiming["cycle_kind"]): ScheduleCycleTiming {
  const startedAt = new Date().toISOString();
  scheduleCycleSequence += 1;
  return { cycleID: `${kind}:${startedAt}:${scheduleCycleSequence}`, input, kind, startedAt };
}

function resultSummary(value: unknown): Record<string, number> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const summary = Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => typeof item === "number" && Number.isFinite(item))
    .slice(0, 16)) as Record<string, number>;
  return Object.keys(summary).length > 0 ? summary : undefined;
}

function roundedTiming(timing: ScheduleTiming): ScheduleTiming {
  return {
    ...timing,
    duration_ms: Math.round(timing.duration_ms),
    operation_ms: Math.round(timing.operation_ms),
    post_yield_ms: Math.round(timing.post_yield_ms),
    queue_wait_ms: Math.round(timing.queue_wait_ms)
  };
}

function createCycleScheduler<Timer>(
  input: PiAutoManageSchedulerInput<Timer>,
  cycle: () => Promise<unknown>
): PiAutoManageScheduler {
  const clock = input.clock ?? defaultClock<Timer>();
  const intervalMs = input.intervalMs ?? DEFAULT_INTERVAL_MS;
  let timer: Timer | undefined;
  let stopped = true;
  const schedule = (delayMs = intervalMs) => { timer = clock.setTimeout(tick, delayMs); };
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
      schedule(input.initialDelayMs ?? intervalMs);
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
  delivery: GuardianAlertDelivery | undefined
): Promise<GuardianMissedIntentSweepResult> {
  const result = runGuardianMissedIntentSweepOnce(input.database, {
    fallbackConnectorID: singleImConnectorID(input.imChannels),
    now: input.watchdogNow,
    watchdog
  });
  await sendMissedDigestPendingFallback(input.database, result.pendingAlertIds, delivery);
  return result;
}

function singleImConnectorID(registry: ImChannelRegistry | undefined): string {
  const ids = registry?.list().map((module) => module.id) ?? [];
  return ids.length === 1 ? ids[0]! : "";
}

function dispatchSchedulerImOutbox(input: PiAutoManageCycleInput) {
  if (!input.imChannels) throw new Error("im channel registry is not configured");
  return dispatchImOutbox({
    database: input.database,
    now: optionalDate(input.watchdogNow),
    resolveConnector: (source) => input.imChannels!.get(source).connector
  });
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
