import { join } from "node:path";
import { createHttpAgenticWorkerClient } from "../agentic/client.ts";
import type { AgenticWorkerClient } from "../agentic/protocol.ts";
import { coldStartTrace } from "../benchmarks/coldStart.ts";
import { loadConfig } from "../config/env.ts";
import { openDatabase } from "../db/database.ts";
import { EventBus } from "../events/bus.ts";
import { BackgroundProjectionWorker } from "../events/projectionWorker.ts";
import { createAuthTokenManager } from "../http/auth.ts";
import { startServer } from "../http/server.ts";
import { primeProviderStatus } from "../http/systemStatus.ts";
import { createFeishuChannelModule, createBuiltinImChannelRegistry } from "../integrations/feishuChannelModule.ts";
import { createImReceiverRuntime, type ImReceiverRuntime } from "../integrations/imChannelContracts.ts";
import {
  ProcessGroupMemoryObserver,
  resolveRecoveredProcessGroupMemoryAlerts,
  writeProcessGroupMemoryAlert
} from "../observability/processGroupMemory.ts";
import { primeRuntimeObservability } from "../observability/runtimeObservability.ts";
import { claudeProviderAppEvent } from "../providers/claude/provider.ts";
import { claudeFactory } from "../providers/claude/factory.ts";
import { piFactory } from "../providers/pi/factory.ts";
import { qoderFactory } from "../providers/qoder/factory.ts";
import type { CodexExecutorProvider } from "../providers/codex/provider.ts";
import { codexFactory } from "../providers/codex/factory.ts";
import { createProviderRegistry, type ProviderProcessLease, type ProviderRegistry, type RegisteredProvider } from "../providers/core/registry.ts";
import { aggregateParityReports, compareCapabilitiesParity, legacyProjectionCompareEnabled } from "../providers/core/parity.ts";
import { reconcileStaleCodexProcessOwnership } from "../providers/codex/processLifecycle.ts";
import {
  createPiAgenticScheduler,
  createPiGuardianScheduler,
  type PiAutoManageSchedulerInput
} from "../runner/piAutoManageScheduler.ts";
import { setProjectLoopMaxParallelProjects, startProjectLoop } from "../runner/projectLoopManager.ts";
import { recoverInProgressIssues } from "../runner/recovery.ts";
import { reconcileStaleAgentSessions } from "../runner/staleSessionReconciler.ts";
import { assertInternalCoreAddress } from "../serverRole.ts";
import { redactSensitiveText } from "../util/redact.ts";

export async function startCoreRuntime(args: string[], role: "all" | "core"): Promise<void> {
  const loadedConfig = loadConfig(args);
  const config = role === "core" ? { ...loadedConfig, webDir: "" } : loadedConfig;
  if (role === "core") assertInternalCoreAddress(config.addr);
  coldStartTrace("config_loaded");
  const database = await openDatabase({ dbPath: config.dbPath, stateDir: config.stateDir });
  const readDatabase = await openDatabase({ readonlyImportPath: database.path });
  const authTokenManager = await createAuthTokenManager(config);
  const agenticClient = role === "core"
    ? createHttpAgenticWorkerClient({ addr: config.agenticAddr, authTokenProvider: authTokenManager.refresh })
    : (await import("../agentic/embeddedClient.ts")).createEmbeddedAgenticWorkerClient(database);
  coldStartTrace("database_opened");
  const bus = new EventBus();
  const projectionWorker = new BackgroundProjectionWorker(database);
  const codexOwnershipFile = join(config.stateDir, "codex-process-ownership.json");
  const processReconciliation = await reconcileStaleCodexProcessOwnership(codexOwnershipFile);
  // W1 receipt cutover: provider_request_ref/result_json are the authoritative
  // im_reply receipts. Idempotent backfill promotes historical rows that only
  // carry the legacy feishu_message_id compat carrier.
  const { backfillImReplyProviderRequestRef } = await import("../db/repositories/imReplyOutboxDispatch.ts");
  const backfilled = backfillImReplyProviderRequestRef(database);
  if (backfilled > 0) {
    console.info(JSON.stringify({ event: "im.outbox_receipt_backfill", rows: backfilled }));
  }
  // P7：registry 装配——codex factory 编译期内置；/api/providers 与 system status 由 registry 投影。
  const providersRegistry = createProviderRegistry();
  if (config.providers.codex) {
    providersRegistry.registerFactory(codexFactory({
      appEventSink: (event) => bus?.publish(event),
      ownershipFile: codexOwnershipFile
    }));
  }
  if (config.providers.claude) {
    providersRegistry.registerFactory(claudeFactory({
      eventSink: (event) => bus?.publish(claudeProviderAppEvent(event))
    }));
  }
  if (config.providers["pi-coding-agent"]) {
    providersRegistry.registerFactory(piFactory({ command: config.providers["pi-coding-agent"].command ?? "pi" }));
  }
  if (config.providers.qoder) {
    providersRegistry.registerFactory(qoderFactory({}));
  }
  await providersRegistry.startConfigured(config.providers as Record<string, { enabled?: boolean } & Record<string, unknown>>);
  // P9：W2 观察窗——flag 开启时对比 manifest/实例 capabilities parity 并记录 drift（rollback 无 DB 回填）。
  if (legacyProjectionCompareEnabled()) {
    const parityAggregated = aggregateParityReports(providersRegistry.list().map(compareCapabilitiesParity));
    if (parityAggregated.ok) {
      console.info(JSON.stringify({ event: "provider.legacy_projection_parity_ok" }));
    } else {
      console.warn(JSON.stringify({
        event: "provider.legacy_projection_drift",
        drifted_providers: parityAggregated.driftedProviders,
        diffs: parityAggregated.diffs
      }));
    }
  }
  const providers = providersRegistry.readyProviders();
  const runtimeStartedAt = new Date().toISOString();
  const providerRuntime = () => {
    const codex = providers.codex as (RegisteredProvider & { runtimeSnapshot?: CodexExecutorProvider["runtimeSnapshot"] }) | undefined;
    return codex?.runtimeSnapshot?.();
  };
  const providerLeases = () => providersRegistry.collectProcessLeases();
  const processGroupMemory = new ProcessGroupMemoryObserver({
    activeRuns: () => database.sqlite.query<{ count: number }, []>(
      "select count(*) as count from issue_runs where ended_at=''"
    ).get()?.count ?? 0,
    agenticActivity: agenticClient.activity,
    // The observer uses non-suspending proc_pid_rusage for physical footprint.
    // Keep process discovery allocation-free on the HTTP loop while retaining
    // provider descendants from the lifecycle-owned runtime snapshot.
    inspect: () => runtimeMemoryRows(runtimeStartedAt, providerRuntime(), agenticClient.activity(), providerLeases()),
    onAlert: (alert) => writeProcessGroupMemoryAlert(database, alert),
    onRecovery: (recovery) => resolveRecoveredProcessGroupMemoryAlerts(database, recovery),
    providerRuntime,
    reclaimMemory: () => Bun.gc(true)
  });
  processGroupMemory.start();
  const sessionReconciliation = reconcileStaleAgentSessions(
    database,
    processReconciliation,
    new Date(),
    { reconcileManagerConversations: role === "all" }
  );
  coldStartTrace("providers_initialized");
  setProjectLoopMaxParallelProjects(config.runner.maxParallelProjects);
  const feishuModule = createFeishuChannelModule({
    bus,
    config: () => config.integrations.feishu,
    database,
    providers,
    runSupervisorConversation: async ({ channelContext, conversationId, prompt, targetIssueId, targetProjectId, targetProjectSource, title }) => {
      const { runPiConversationPrompt } = await import("../http/piConversationApi.ts");
      const result = await runPiConversationPrompt({ bus, database, providers }, {
        channelContext,
        clearProjectId: true,
        conversationId,
        projectId: "",
        prompt,
        targetProjectId,
        targetProjectSource,
        targetIssueId,
        title
      });
      return { conversationId: result.conversation_id, targetProjectId, text: result.text };
    }
  });
  const imChannels = createBuiltinImChannelRegistry({ feishu: feishuModule.module });
  const imReceiverRuntime = createImReceiverRuntime(imChannels);
  coldStartTrace("connectors_initialized");
  await primeRuntimeObservability(readDatabase).catch((error) => {
    console.warn(JSON.stringify({
      event: "runner.runtime_observability_prime_failed",
      error: safeError(error)
    }));
  });
  primeProviderStatus(config);
  const server = await startServer(config, {
    agenticClient,
    authTokenManager,
    bus,
    database,
    readDatabase,
    feishuAgentBridge: feishuModule.agentBridge,
    feishuReceiverStatus: () => feishuModule.receiverStatus(),
    imChannels,
    onFeishuConfigChanged: (next) => feishuModule.onConfigChanged?.(next),
    processGroupMemory,
    projectionWorker,
    providers,
    providersRegistry,
    role
  });
  installTerminationHandlers(providersRegistry, database, readDatabase, server, processGroupMemory, projectionWorker, imReceiverRuntime);
  coldStartTrace("http_routes_registered");
  void imReceiverRuntime.start().catch((error) => {
    console.error(JSON.stringify({ ok: false, service: "xuanwu backend-ts", component: "im-receiver-runtime", error: safeError(error) }));
  });
  projectionWorker.start();
  void startAutoRunLoops(
    database,
    providers,
    bus,
    config.codexSessionsDir,
    config,
    processReconciliation,
    agenticClient,
    processGroupMemory,
    imChannels,
    feishuModule.guardianAlertDelivery
  );
  coldStartTrace("scheduler_watchdog_initialized");

  console.log(JSON.stringify({
    ok: true,
    service: "xuanwu backend-ts",
    role,
    listen: `${server.hostname}:${server.port}`,
    config: {
      addr: config.addr,
      agenticAddr: config.agenticAddr,
      stateDir: config.stateDir,
      dbPath: database.path,
      webDir: role === "all" ? config.webDir : ""
    },
    lifecycle_reconciliation: sessionReconciliation
  }, null, 2));
}

function runtimeMemoryRows(
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

function rawProcessCommand(command: string): string {
  return command.includes("\t") ? command.slice(command.indexOf("\t") + 1) : command;
}

function installTerminationHandlers(
  providersRegistry: ProviderRegistry,
  database: Awaited<ReturnType<typeof openDatabase>>,
  readDatabase: Awaited<ReturnType<typeof openDatabase>>,
  server: { stop(closeActiveConnections?: boolean): void },
  processGroupMemory: ProcessGroupMemoryObserver,
  projectionWorker: BackgroundProjectionWorker,
  imReceiverRuntime: ImReceiverRuntime
): void {
  let stopping = false;
  const stop = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.info(JSON.stringify({ event: "runner.shutdown_started", role: "core", signal }));
    processGroupMemory.stop();
    projectionWorker.stop();
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

async function startAutoRunLoops(
  database: Awaited<ReturnType<typeof openDatabase>>,
  providers: Record<string, RegisteredProvider>,
  bus: EventBus,
  codexSessionsDir: string,
  config: ReturnType<typeof loadConfig>,
  processReconciliation: Awaited<ReturnType<typeof reconcileStaleCodexProcessOwnership>>,
  agenticClient: AgenticWorkerClient,
  processGroupMemory: ProcessGroupMemoryObserver,
  imChannels: ReturnType<typeof createBuiltinImChannelRegistry>,
  guardianAlertDelivery: import("../pi/guardianAlertDelivery.ts").GuardianAlertDelivery
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
  createPiAgenticScheduler(schedulerInput).start();
}

function logProjectLoopError(error: unknown, projectId: string): void {
  console.error(JSON.stringify({ ok: false, service: "xuanwu backend-ts", projectId, error: safeError(error) }));
}

function safeError(error: unknown): string {
  return redactSensitiveText(error instanceof Error ? error.message : String(error));
}
