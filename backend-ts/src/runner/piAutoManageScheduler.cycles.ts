import { runDigestFlushSchedulerOnce } from "../pi/notifications/digestFlushScheduler.ts";
import { queueReadyImDigestNotifications } from "../pi/notifications/digestNotifications.ts";
import { queuePendingImActionNotifications } from "../pi/actions/pendingActionNotifications.ts";
import { queueDailyNotificationDigests } from "../notifications/dailyDigest.ts";
import { runAgentCommunicationGatewayOnce } from "../notifications/agentCommunicationGateway.ts";
import { drainGuardianDecisionOrchestrator } from "../pi/guardian/guardianDecisionOrchestrator.ts";
import { dispatchApprovedGuardianActions } from "./piGuardianActionDispatcher.ts";
import { runPiGuardianWatchdogOnce } from "../pi/guardian/guardianWatchdog.ts";
import { resolveRecoveredAlerts } from "../pi/guardian/guardianWatchdogMaintenance.ts";
import { queueGuardianOperationsDailyReports } from "../pi/guardian/guardianOperationsDailyReport.ts";
import { runPiIssueSupervisorSchedulerOnce } from "./piIssueSupervisorScheduler.ts";
import { runPiAcceptanceCoordinatorOnce } from "./piAcceptanceCoordinator.ts";
import { runDueAutomations } from "./automationScheduler.ts";
import { createNativeAutomationExecutor } from "./automationRuntime.ts";
import { runWatchAutomationsOnce } from "./watchAutomationRuntime.ts";
import { signalOpenRunTerminalProviderErrors } from "./providerTerminalSignals.ts";
import { runAutoRunIssueWatchdogOnce } from "./issueWatchdog.ts";
import type { PiAutoManageCycleInput, ScheduleLayerCycleResult, GuardianControlPlaneCycleResult, AgenticCycleResult, PiAutoManageCycleResult } from "./piAutoManageScheduler.model.ts";
import { scheduleCycleTiming, SLOW_SCHEDULE_PHASE_MS, logCycleTiming, timedSchedulePhase } from "./piAutoManageScheduler.timing.ts";
import { optionalDate, runMissedIntentSweepWithFallback, cycleNowText, dispatchSchedulerImOutbox } from "./piAutoManageScheduler.delivery.ts";

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
