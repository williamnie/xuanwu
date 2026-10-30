import type { AgenticWorkerClient } from "../agentic/protocol.ts";
import { loadConfig } from "../config/env.ts";
import { openDatabase } from "../db/database.ts";
import { EventBus } from "../events/bus.ts";
import { BackgroundProjectionWorker } from "../events/projectionWorker.ts";
import { createBuiltinImChannelRegistry } from "../integrations/feishu/feishuChannelModule.ts";
import { type ImReceiverRuntime } from "../integrations/im/imChannelContracts.ts";
import { ProcessGroupMemoryObserver } from "../observability/processGroupMemory.ts";
import type { CodexExecutorProvider } from "../providers/codex/provider.ts";
import { type ProviderProcessLease, type ProviderRegistry, type RegisteredProvider } from "../providers/core/registry.ts";
import { reconcileStaleCodexProcessOwnership } from "../providers/codex/processLifecycle.ts";
import { AGENTIC_INITIAL_DELAY_MS, createPiAgenticScheduler, createPiGuardianScheduler, type PiAutoManageSchedulerInput } from "../runner/piAutoManageScheduler.ts";
import { startProjectLoop } from "../runner/projectLoopManager.ts";
import { recoverInProgressIssues } from "../runner/recovery.ts";
import { reconcileStaleAgentSessions } from "../runner/staleSessionReconciler.ts";
import { redactSensitiveText } from "../util/redact.ts";
import { type ReleaseUpdateMonitor } from "../release/releaseUpdateMonitor.ts";
import { GitHubIssueSyncRuntime } from "../integrations/github/issueSyncRuntime.ts";

export function runtimeMemoryRows(
  runtimeStartedAt: string,
  runtime: ReturnType<CodexExecutorProvider["runtimeSnapshot"]>,
  agentic: ReturnType<AgenticWorkerClient["activity"]>,
  leases: readonly ProviderProcessLease[] = []
) {
  const root = {
    command: `${runtimeStartedAt}\txuanwu-core`,
    pgid: process.pid,
    pid: process.pid,
    ppid: process.ppid,
    rss_bytes: process.memoryUsage.rss()
  };
  const rows = [root];
  if (Number.isSafeInteger(agentic.worker_pid) && agentic.worker_pid! > 0 && agentic.worker_pid !== process.pid) {
    rows.push({
      command: `${agentic.worker_started_at || "unknown"}\txuanwu-agentic`,
      pgid: agentic.worker_pid!,
      pid: agentic.worker_pid!,
      ppid: process.pid,
      rss_bytes: Math.max(0, agentic.worker_rss_bytes ?? 0)
    });
  }
  const ownershipRows = runtime?.process?.processes.map((row) => ({
    ...row,
    command: `${runtime?.process?.started_at}\t${rawProcessCommand(row.command)}`
  })) ?? [];
  const known = new Set([root.pid, ...ownershipRows.map((row) => row.pid)]);
  const leaseRows = leases.filter((lease) => !known.has(lease.pid)).map((lease) => ({
    command: `${lease.startedAt}\t${lease.commandLabel}`,
    pgid: lease.pgid ?? lease.pid,
    pid: lease.pid,
    ppid: process.pid,
    rss_bytes: 0
  }));
  return [...rows, ...ownershipRows, ...leaseRows];
}

export function rawProcessCommand(command: string): string {
  return command.includes("\t") ? command.slice(command.indexOf("\t") + 1) : command;
}

export function installTerminationHandlers(
  providersRegistry: ProviderRegistry,
  database: Awaited<ReturnType<typeof openDatabase>>,
  readDatabase: Awaited<ReturnType<typeof openDatabase>>,
  server: { stop(closeActiveConnections?: boolean): void },
  processGroupMemory: ProcessGroupMemoryObserver,
  projectionWorker: BackgroundProjectionWorker,
  imReceiverRuntime: ImReceiverRuntime,
  releaseUpdateMonitor: ReleaseUpdateMonitor,
  githubIssueSync: GitHubIssueSyncRuntime
): void {
  let stopping = false;
  const stop = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.info(JSON.stringify({ event: "runner.shutdown_started", role: "core", signal }));
    processGroupMemory.stop();
    projectionWorker.stop();
    releaseUpdateMonitor.stop();
    await githubIssueSync.stop();
    await imReceiverRuntime.stop();
    server.stop(true);
    await providersRegistry.stopAll();
    readDatabase.close();
    database.close();
    process.exit(0);
  };
  process.on("SIGINT", () => { void stop("SIGINT"); });
  process.on("SIGTERM", () => { void stop("SIGTERM"); });
}

export async function startAutoRunLoops(
  database: Awaited<ReturnType<typeof openDatabase>>,
  providers: Record<string, RegisteredProvider>,
  bus: EventBus,
  codexSessionsDir: string,
  config: ReturnType<typeof loadConfig>,
  processReconciliation: Awaited<ReturnType<typeof reconcileStaleCodexProcessOwnership>>,
  agenticClient: AgenticWorkerClient,
  processGroupMemory: ProcessGroupMemoryObserver,
  imChannels: ReturnType<typeof createBuiltinImChannelRegistry>,
  guardianAlertDelivery: import("../pi/guardian/guardianAlertDelivery.ts").GuardianAlertDelivery
): Promise<void> {
  await recoverInProgressIssues({ database }).catch((error) => {
    console.error(JSON.stringify({ ok: false, service: "xuanwu backend-ts", error: safeError(error) }));
  });
  reconcileStaleAgentSessions(database, processReconciliation, new Date(), { reconcileManagerConversations: false });
  const projects = database.sqlite.query<{ id: string }, []>(
    "select id from projects where auto_run=1 order by sort_order asc, created_at asc, id asc"
  ).all();
  for (const project of projects) startProjectLoop({ bus, database, providers, onError: logProjectLoopError }, project.id);
  const schedulerInput: PiAutoManageSchedulerInput = {
    bus,
    codexSessionsDir,
    config,
    database,
    decideIssueAcceptance: (card) => {
      if (!agenticClient.decideIssueAcceptance) throw new Error("Agentic Worker does not support issue acceptance");
      return agenticClient.decideIssueAcceptance(card);
    },
    agentCommunicationDecider: (input) => agenticClient.decideCommunication(input),
    providers,
    imChannels,
    guardianAlertDelivery,
    onError: (error) => {
      console.error(JSON.stringify({ ok: false, service: "xuanwu backend-ts", error: safeError(error) }));
    },
    runProjectCycle: (input) => agenticClient.runProjectCycle(input),
    runSupervisorDecision: (context) => agenticClient.decideSupervisor(context),
    runWithinActivity: (operation) => processGroupMemory.runMaintenance(operation)
  };
  createPiGuardianScheduler(schedulerInput).start();
  createPiAgenticScheduler({ ...schedulerInput, initialDelayMs: AGENTIC_INITIAL_DELAY_MS }).start();
}

export function logProjectLoopError(error: unknown, projectId: string): void {
  console.error(JSON.stringify({ ok: false, service: "xuanwu backend-ts", projectId, error: safeError(error) }));
}

export function safeError(error: unknown): string {
  return redactSensitiveText(error instanceof Error ? error.message : String(error));
}
