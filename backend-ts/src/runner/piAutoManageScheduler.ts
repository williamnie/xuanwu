import type { RunnerDatabase } from "../db/database.ts";
import type { RunnerConfig } from "../config/env.ts";
import { isPiHeartbeatPaused } from "../db/repositories/pi.ts";
import type { EventBus } from "../events/bus.ts";
import { queueReadyFeishuCompletionWatchNotifications } from "../integrations/feishuCompletionWatchNotifications.ts";
import { queueReadyFeishuDigestNotifications } from "../integrations/feishuLifecycleNotifications.ts";
import type { PiGuardianDirectFeishuOptions } from "../integrations/feishuGuardianAlerts.ts";
import type { FeishuMessageClient } from "../integrations/feishuClient.ts";
import type { ExecutorProvider, ExecutorProviderId } from "../providers/types.ts";
import { runDigestFlushSchedulerOnce } from "../pi/digestFlushScheduler.ts";
import { queueDailyNotificationDigests, type DailyDigestResult } from "../notifications/dailyDigest.ts";
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
import { runDelegationHeartbeatsOnce } from "../pi/heartbeatOrchestrator.ts";
import { runPiIssueSupervisorSchedulerOnce } from "./piIssueSupervisorScheduler.ts";
import { runDueCronTasks } from "./cronExecutor.ts";
import {
  runDuePiAutomations,
  type PiAutomationExecutor,
  type PiAutomationSchedulerResult
} from "./piAutomationScheduler.ts";
import {
  runDueAutomations,
  type AutomationExecutor,
  type AutomationSchedulerResult
} from "./automationScheduler.ts";
import { createNativeAutomationExecutor } from "./automationRuntime.ts";
import { runWatchAutomationsOnce } from "./watchAutomationRuntime.ts";
import {
  signalOpenRunTerminalProviderErrors,
  type ProviderTerminalBackfillSummary
} from "./providerTerminalSignals.ts";
import {
  runAutoRunIssueWatchdogOnce,
  type IssueWatchdogSummary
} from "./issueWatchdog.ts";

export type PiAutoManageProjectCycleInput = { maxActions: number; projectId: string };
export type PiAutoManageProjectCycle = (input: PiAutoManageProjectCycleInput) => Promise<unknown>;
export type PiAutoManageCycleResult = { projects: number; skipped: number; started: number };
export type ScheduleLayerCycleResult = PiAutoManageCycleResult & {
  automationCore: AutomationSchedulerResult;
  automations: PiAutomationSchedulerResult;
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
  watchdog: PiGuardianWatchdogSummary;
};

export type PiAutoManageCycleInput = {
  bus?: EventBus;
  codexSessionsDir?: string;
  config?: RunnerConfig;
  database: RunnerDatabase;
  guardianDirectFeishuSender?: FeishuMessageClient;
  providers?: Partial<Record<ExecutorProviderId, ExecutorProvider>>;
  runAutomationCore?: AutomationExecutor;
  runAutomation?: PiAutomationExecutor;
  runProjectCycle: PiAutoManageProjectCycle;
  runSupervisor?: boolean;
  watchdogNow?: Date | string;
  watchdogStaleAfterMs?: number;
};

export type PiAutoManageSchedulerClock<Timer = unknown> = {
  clearTimeout(timer: Timer): void;
  setTimeout(callback: () => void, delayMs: number): Timer;
};

export type PiAutoManageSchedulerInput<Timer = unknown> = PiAutoManageCycleInput & {
  clock?: PiAutoManageSchedulerClock<Timer>;
  intervalMs?: number;
  onError?: (error: unknown) => void;
  supervisorIntervalMs?: number;
};

export type PiAutoManageScheduler = {
  start(): void;
  stop(): void;
};

type EnabledProjectRow = { max_actions_per_cycle: number; project_id: string };

const DEFAULT_INTERVAL_MS = 30_000;
const DEFAULT_SUPERVISOR_INTERVAL_MS = 60_000;
const activeProjectCycles = new Set<string>();

export function createPiAutoManageScheduler<Timer = unknown>(
  input: PiAutoManageSchedulerInput<Timer>
): PiAutoManageScheduler {
  const runtimeInput = withNativeAutomationExecutor(input);
  const clock = input.clock ?? defaultClock<Timer>();
  const intervalMs = input.intervalMs ?? DEFAULT_INTERVAL_MS;
  const supervisorIntervalMs = input.supervisorIntervalMs ?? DEFAULT_SUPERVISOR_INTERVAL_MS;
  let lastSupervisorScanAt = 0;
  let timer: Timer | undefined;
  let stopped = true;

  const schedule = () => {
    timer = clock.setTimeout(tick, intervalMs);
  };
  const tick = () => {
    const now = Date.now();
    const runSupervisor = shouldRunSupervisor(now, lastSupervisorScanAt, supervisorIntervalMs);
    if (runSupervisor) lastSupervisorScanAt = now;
    void runScheduleLayerCycle({ ...runtimeInput, runSupervisor }).catch((error) => {
      input.onError?.(error);
    }).finally(() => {
      if (!stopped) schedule();
    });
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
  const supervisor = input.runSupervisor === false
    ? { decisions: 0, failed: 0, scanned: 0, signaled: 0, skipped: 0 }
    : await runPiIssueSupervisorSchedulerOnce({ database: input.database, providers: input.providers });
  const cron = await runDueCronTasks({
    bus: input.bus,
    codexSessionsDir: input.codexSessionsDir,
    config: input.config,
    database: input.database,
    runProjectCycle: input.runProjectCycle
  });
  const automations = await runDuePiAutomations({
    database: input.database,
    executeAutomation: input.runAutomation,
    now: optionalDate(input.watchdogNow)
  });
  const automationCore = await runDueAutomations({
    database: input.database,
    executeAutomation: input.runAutomationCore ?? createNativeAutomationExecutor(input),
    now: optionalDate(input.watchdogNow)
  });
  const delegations = await runDelegationHeartbeatsOnce({ database: input.database });
  const providerTerminalSignals = signalOpenRunTerminalProviderErrors(input.database);
  const guardianDecisions = drainGuardianDecisionOrchestrator(input.database);
  const guardianActionDispatch = await dispatchApprovedGuardianActions({
    bus: input.bus,
    database: input.database,
    providers: input.providers
  });
  const digestFlush = runDigestFlushSchedulerOnce(input.database);
  const directFeishu = guardianDirectFeishuOptions(input);
  const watchdog = await runPiGuardianWatchdogOnce(input.database, {
    directFeishu,
    now: input.watchdogNow,
    staleAfterMs: input.watchdogStaleAfterMs
  });
  const missedIntentSweep = await runMissedIntentSweepWithFallback(input, watchdog, directFeishu);
  resolveRecoveredAlerts(input.database, watchdog.checks, cycleNowText(input.watchdogNow));
  runWatchAutomationsOnce(input.database, { now: input.watchdogNow });
  const dailyDigestNotifications = queueDailyNotificationDigests(input.database, { now: optionalDate(input.watchdogNow) });
  const digestNotifications = queueReadyFeishuDigestNotifications(input.database);
  const completionWatchNotifications = queueReadyFeishuCompletionWatchNotifications(input.database);
  const issueWatchdog = await runAutoRunIssueWatchdogOnce({
    bus: input.bus,
    database: input.database,
    now: input.watchdogNow,
    providers: input.providers,
    staleAfterMs: input.watchdogStaleAfterMs
  });
  const projects = await runPiAutoManageCycle(input);
  return {
    ...projects,
    automationCore,
    automations,
    cron,
    delegations: { scanned: delegations.scanned, skipped: delegations.skipped, started: delegations.started },
    dailyDigestNotifications,
    digestFlush,
    digestNotifications,
    completionWatchNotifications,
    guardianActionDispatch,
    guardianDecisions,
    issueWatchdog,
    missedIntentSweep,
    providerTerminalSignals,
    supervisor,
    watchdog
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
    select s.project_id, s.max_actions_per_cycle
    from project_pi_settings s
    join projects p on p.id = s.project_id
    join pi_agents a on a.id = s.pi_agent_id
    where s.auto_manage = 1 and a.enabled = 1
    order by p.sort_order asc, p.created_at asc, p.id asc
  `).all();
}

async function runManagedProjectCycle(runProjectCycle: PiAutoManageProjectCycle, project: EnabledProjectRow): Promise<void> {
  activeProjectCycles.add(project.project_id);
  try {
    await runProjectCycle({
      maxActions: project.max_actions_per_cycle,
      projectId: project.project_id
    });
  } finally {
    activeProjectCycles.delete(project.project_id);
  }
}

function defaultClock<Timer>(): PiAutoManageSchedulerClock<Timer> {
  return {
    clearTimeout: (timer) => clearTimeout(timer as Timer & ReturnType<typeof setTimeout>),
    setTimeout: (callback, delayMs) => setTimeout(callback, delayMs) as Timer
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
