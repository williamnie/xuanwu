import { startCodexLoginMaintenance } from "../pi/runtime/codexLoginMaintenance.ts";
import { join } from "node:path";
import { createHttpAgenticWorkerClient } from "../agentic/client.ts";
import { coldStartTrace } from "../benchmarks/coldStart.ts";
import { loadConfig } from "../config/env.ts";
import { openDatabase } from "../db/database.ts";
import { openCoreDatabase } from "./coreDatabase.ts";
import { installUnhandledRejectionLogger } from "./unhandledRejection.ts";
import { reconcileReservedImContextBindings } from "../db/repositories/imContextLifecycle.ts";
import { EventBus } from "../events/bus.ts";
import { BackgroundProjectionWorker } from "../events/projectionWorker.ts";
import { createAuthTokenManager } from "../http/auth.ts";
import { startServer } from "../http/server.ts";
import { primeProviderStatus } from "../http/system/systemStatus.ts";
import { createFeishuChannelModule, createBuiltinImChannelRegistry } from "../integrations/feishu/feishuChannelModule.ts";
import { createTelegramChannelModule } from "../integrations/telegram/telegramChannelModule.ts";
import type { ImConversationPromptProjection } from "../integrations/im/imConversationContext.ts";
import { createImGuardianAlertDelivery } from "../integrations/im/imGuardianAlerts.ts";
import { feishuConnectorStatus } from "../integrations/feishu/feishu.ts";
import { createImReceiverRuntime } from "../integrations/im/imChannelContracts.ts";
import { ProcessGroupMemoryObserver, resolveRecoveredProcessGroupMemoryAlerts, writeProcessGroupMemoryAlert } from "../observability/processGroupMemory.ts";
import { primeRuntimeObservability } from "../observability/runtimeObservability.ts";
import { claudeProviderAppEvent } from "../providers/claude/provider.ts";
import { claudeFactory } from "../providers/claude/factory.ts";
import { piFactory } from "../providers/pi/factory.ts";
import { qoderFactory } from "../providers/qoder/factory.ts";
import type { CodexExecutorProvider } from "../providers/codex/provider.ts";
import { codexFactory } from "../providers/codex/factory.ts";
import { createProviderRegistry, type RegisteredProvider } from "../providers/core/registry.ts";
import { reconcileStaleCodexProcessOwnership } from "../providers/codex/processLifecycle.ts";
import { setProjectLoopMaxParallelProjects, startProjectLoop } from "../runner/projectLoopManager.ts";
import { startNodeHubRuntime } from "../nodes/hubRuntime.ts";
import { reconcileStaleAgentSessions } from "../runner/staleSessionReconciler.ts";
import { assertInternalCoreAddress } from "../serverRole.ts";
import { createReleaseUpdateMonitor } from "../release/releaseUpdateMonitor.ts";
import { GitHubIssueSyncRuntime } from "../integrations/github/issueSyncRuntime.ts";
import { GitHubIssueDelivery } from "../integrations/github/issueDelivery.ts";
import { runtimeMemoryRows, safeError, logProjectLoopError, installTerminationHandlers, startAutoRunLoops } from "./core.support.ts";

export async function startCoreRuntime(args: string[], role: "all" | "core"): Promise<void> {
  installUnhandledRejectionLogger();
  const loadedConfig = loadConfig(args);
  const config = role === "core" ? { ...loadedConfig, webDir: "" } : loadedConfig;
  if (role === "core") assertInternalCoreAddress(config.addr);
  coldStartTrace("config_loaded");
  const database = await openCoreDatabase({ dbPath: config.dbPath, stateDir: config.stateDir });
  const reconciledContextBindings = reconcileReservedImContextBindings(database);
  if (reconciledContextBindings > 0) {
    console.info(JSON.stringify({ event: "im.context_bindings_reconciled", rows: reconciledContextBindings }));
  }
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
      ownershipFile: codexOwnershipFile,
      generateTitle: async (input, signal) => {
        const { generateSessionTitle } = await import("../pi/runtime/sessionTitleGenerator.ts");
        return generateSessionTitle(database, input, signal);
      }
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
  const stopCodexLoginMaintenance = startCodexLoginMaintenance(database, config, providersRegistry);
  process.once("SIGTERM", stopCodexLoginMaintenance);
  process.once("SIGINT", stopCodexLoginMaintenance);
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
  const runSupervisorConversation = async ({ channelContext, channelContextProjection, conversationId, prompt, targetIssueId, targetProjectId, targetProjectSource, title }: {
    channelContext: string; channelContextProjection?: ImConversationPromptProjection; conversationId: string; prompt: string; targetIssueId?: number; targetProjectId: string; targetProjectSource?: string; title: string;
  }) => {
    const { runPiConversationPrompt } = await import("../http/pi/piConversationApi.ts");
    const result = await runPiConversationPrompt({ bus, database, providers }, {
      channelContext,
      channelContextProjection,
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
  };
  const feishuModule = createFeishuChannelModule({
    bus,
    config: () => config.integrations.feishu,
    database,
    providers,
    runSupervisorConversation
  });
  const telegramModule = createTelegramChannelModule({
    bus,
    config: () => config.integrations.telegram,
    database,
    providers,
    runSupervisorConversation
  });
  const imChannels = createBuiltinImChannelRegistry({ feishu: feishuModule.module, telegram: telegramModule.module });
  const releaseUpdateMonitor = createReleaseUpdateMonitor({
    database,
    feishuConfig: () => config.integrations.feishu,
    imChannels,
    telegramConfig: () => config.integrations.telegram
  });
  const guardianAlertDelivery = createImGuardianAlertDelivery({
    database,
    fallback: feishuModule.guardianAlertDelivery,
    feishuConfigured: () => feishuConnectorStatus(config.integrations.feishu).enabled === true,
    imChannels,
    telegramConfig: () => config.integrations.telegram
  });
  const imReceiverRuntime = createImReceiverRuntime(imChannels);
  const githubIssueDelivery = new GitHubIssueDelivery({ database, providers, bus });
  const githubIssueSync = new GitHubIssueSyncRuntime({ config: config.integrations.github,
    stateDir: config.stateDir, runtime: { database, providers, bus },
    advanceDelivery: (record, policy, client) => githubIssueDelivery.advance(record, policy, client) });
  coldStartTrace("connectors_initialized");
  await primeRuntimeObservability(readDatabase).catch((error) => {
    console.warn(JSON.stringify({
      event: "runner.runtime_observability_prime_failed",
      error: safeError(error)
    }));
  });
  primeProviderStatus(config);
  const nodeHubRuntime = startNodeHubRuntime({
    bus,
    database,
    onNodeOnline: (projectIds) => {
      for (const projectId of projectIds) startProjectLoop({ bus, database, providers, onError: logProjectLoopError }, projectId);
    }
  });
  const server = await startServer(config, {
    agenticClient,
    authTokenManager,
    bus,
    database,
    nodeHub: nodeHubRuntime.hub,
    readDatabase,
    feishuAgentBridge: feishuModule.agentBridge,
    feishuReceiverStatus: () => feishuModule.receiverStatus(),
    imChannels,
    onFeishuConfigChanged: (next) => feishuModule.onConfigChanged?.(next),
    onTelegramConfigChanged: (next) => telegramModule.onConfigChanged?.(next),
    processGroupMemory,
    projectionWorker,
    providers,
    providersRegistry,
    releaseUpdateMonitor,
    githubIssueSync,
    role
  });
  installTerminationHandlers(providersRegistry, database, readDatabase, server, processGroupMemory, projectionWorker, imReceiverRuntime, releaseUpdateMonitor, githubIssueSync);
  coldStartTrace("http_routes_registered");
  void imReceiverRuntime.start().catch((error) => {
    console.error(JSON.stringify({ ok: false, service: "xuanwu backend-ts", component: "im-receiver-runtime", error: safeError(error) }));
  });
  projectionWorker.start();
  releaseUpdateMonitor.start();
  githubIssueSync.start();
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
    guardianAlertDelivery
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
