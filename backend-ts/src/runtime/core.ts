import { join } from "node:path";
import { coldStartTrace } from "../benchmarks/coldStart.ts";
import { loadConfig } from "../config/env.ts";
import { openDatabase } from "../db/database.ts";
import { EventBus } from "../events/bus.ts";
import { BackgroundProjectionWorker } from "../events/projectionWorker.ts";
import { runProjectPiCycle } from "../http/piProjectControlApi.ts";
import { startServer } from "../http/server.ts";
import { primeProviderStatus } from "../http/systemStatus.ts";
import type { FeishuConnectorConfig } from "../integrations/feishu.ts";
import { createFeishuAgentBridge } from "../integrations/feishuAgentBridge.ts";
import { buildFeishuConversationPromptContext } from "../integrations/feishuConversationContext.ts";
import { createFeishuReceiverManager } from "../integrations/feishuReceiver.ts";
import {
  ProcessGroupMemoryObserver,
  resolveRecoveredProcessGroupMemoryAlerts,
  writeProcessGroupMemoryAlert
} from "../observability/processGroupMemory.ts";
import { primeRuntimeObservability } from "../observability/runtimeObservability.ts";
import { createClaudeExecutorProvider } from "../providers/claude/provider.ts";
import { createCodexExecutorProvider } from "../providers/codex/provider.ts";
import { reconcileStaleCodexProcessOwnership } from "../providers/codex/processLifecycle.ts";
import { createPiAutoManageScheduler } from "../runner/piAutoManageScheduler.ts";
import { setProjectLoopMaxParallelProjects, startProjectLoop } from "../runner/projectLoopManager.ts";
import { recoverInProgressIssues } from "../runner/recovery.ts";
import { reconcileStaleAgentSessions } from "../runner/staleSessionReconciler.ts";
import { assertInternalCoreAddress, type ServerRole } from "../serverRole.ts";
import { redactSensitiveText } from "../util/redact.ts";

type FeishuReceiver = ReturnType<typeof createFeishuReceiverManager>;
let activeFeishuReceiver: FeishuReceiver | undefined;

export async function startCoreRuntime(args: string[], role: Exclude<ServerRole, "web">): Promise<void> {
  const loadedConfig = loadConfig(args);
  const config = role === "core" ? { ...loadedConfig, webDir: "" } : loadedConfig;
  if (role === "core") assertInternalCoreAddress(config.addr);
  coldStartTrace("config_loaded");
  const database = await openDatabase({ dbPath: config.dbPath, stateDir: config.stateDir });
  const readDatabase = await openDatabase({ readonlyImportPath: database.path });
  coldStartTrace("database_opened");
  const bus = new EventBus();
  const projectionWorker = new BackgroundProjectionWorker(database);
  const codexOwnershipFile = join(config.stateDir, "codex-process-ownership.json");
  const processReconciliation = await reconcileStaleCodexProcessOwnership(codexOwnershipFile);
  const providers = executorProviders(config, bus, codexOwnershipFile);
  const runtimeStartedAt = new Date().toISOString();
  const providerRuntime = () => (providers.codex as ReturnType<typeof createCodexExecutorProvider> | undefined)?.runtimeSnapshot();
  const processGroupMemory = new ProcessGroupMemoryObserver({
    activeRuns: () => database.sqlite.query<{ count: number }, []>(
      "select count(*) as count from issue_runs where ended_at=''"
    ).get()?.count ?? 0,
    // The observer uses non-suspending proc_pid_rusage for physical footprint.
    // Keep process discovery allocation-free on the HTTP loop while retaining
    // provider descendants from the lifecycle-owned runtime snapshot.
    inspect: () => runtimeMemoryRows(runtimeStartedAt, providerRuntime()),
    onAlert: (alert) => writeProcessGroupMemoryAlert(database, alert),
    onRecovery: (recovery) => resolveRecoveredProcessGroupMemoryAlerts(database, recovery),
    providerRuntime
  });
  processGroupMemory.start();
  const sessionReconciliation = reconcileStaleAgentSessions(database, processReconciliation);
  coldStartTrace("providers_initialized");
  setProjectLoopMaxParallelProjects(config.runner.maxParallelProjects);
  const feishuBridge = createFeishuAgentBridge({
    config: () => config.integrations.feishu,
    database,
    runConversation: async ({ conversationId, event, projectId, prompt, targetProjectId, targetProjectSource }) => {
      const { runPiConversationPrompt } = await import("../http/piConversationApi.ts");
      const oneShotTargetProjectId = targetProjectId || projectId;
      const result = await runPiConversationPrompt({ bus, database, providers }, {
        channelContext: buildFeishuConversationPromptContext(database, { event }),
        clearProjectId: true,
        conversationId,
        projectId: "",
        prompt,
        targetProjectId: oneShotTargetProjectId,
        targetProjectSource,
        title: `Feishu · ${event.chat_id || event.message_id}`
      });
      return { conversationId: result.conversation_id, projectId: "", targetProjectId: oneShotTargetProjectId, text: result.text };
    }
  });
  const feishuReceiver = createFeishuReceiverManager({ agentBridge: feishuBridge, bus, database, providers });
  activeFeishuReceiver = feishuReceiver;
  coldStartTrace("connectors_initialized");
  await primeRuntimeObservability(readDatabase).catch((error) => {
    console.warn(JSON.stringify({
      event: "runner.runtime_observability_prime_failed",
      error: safeError(error)
    }));
  });
  primeProviderStatus(config);
  const server = await startServer(config, {
    bus,
    database,
    readDatabase,
    feishuAgentBridge: feishuBridge,
    feishuReceiverStatus: () => feishuReceiver.status(),
    onFeishuConfigChanged: restartFeishuReceiver,
    processGroupMemory,
    projectionWorker,
    providers,
    role
  });
  installTerminationHandlers(providers, database, readDatabase, server, processGroupMemory, projectionWorker);
  coldStartTrace("http_routes_registered");
  void restartFeishuReceiver(config.integrations.feishu);
  projectionWorker.start();
  void startAutoRunLoops(database, providers, bus, config.codexSessionsDir, config, processReconciliation);
  coldStartTrace("scheduler_watchdog_initialized");

  console.log(JSON.stringify({
    ok: true,
    service: "codex-issue-runner backend-ts",
    role,
    listen: `${server.hostname}:${server.port}`,
    config: {
      addr: config.addr,
      stateDir: config.stateDir,
      dbPath: database.path,
      webDir: role === "all" ? config.webDir : ""
    },
    lifecycle_reconciliation: sessionReconciliation
  }, null, 2));
}

function runtimeMemoryRows(
  runtimeStartedAt: string,
  runtime: ReturnType<ReturnType<typeof createCodexExecutorProvider>["runtimeSnapshot"]>
) {
  const root = {
    command: `${runtimeStartedAt}\tcodex-issue-runner-core`,
    pgid: process.pid,
    pid: process.pid,
    ppid: process.ppid,
    rss_bytes: process.memoryUsage.rss()
  };
  const ownership = runtime?.process;
  if (!ownership) return [root];
  return [root, ...ownership.processes.map((row) => ({
    ...row,
    command: `${ownership.started_at}\t${rawProcessCommand(row.command)}`
  }))];
}

function rawProcessCommand(command: string): string {
  return command.includes("\t") ? command.slice(command.indexOf("\t") + 1) : command;
}

function executorProviders(config: ReturnType<typeof loadConfig>, bus?: EventBus, codexOwnershipFile = "") {
  const providers: Partial<Record<"codex" | "claude", ReturnType<typeof createCodexExecutorProvider> | ReturnType<typeof createClaudeExecutorProvider>>> = {};
  const codexConfig = config.providers.codex;
  const claudeConfig = config.providers.claude;
  if (codexConfig) providers.codex = createCodexExecutorProvider(
    codexConfig,
    (event) => bus?.publish(event),
    { ownershipFile: codexOwnershipFile }
  );
  if (claudeConfig) providers.claude = createClaudeExecutorProvider(claudeConfig);
  return providers;
}

function installTerminationHandlers(
  providers: ReturnType<typeof executorProviders>,
  database: Awaited<ReturnType<typeof openDatabase>>,
  readDatabase: Awaited<ReturnType<typeof openDatabase>>,
  server: { stop(closeActiveConnections?: boolean): void },
  processGroupMemory: ProcessGroupMemoryObserver,
  projectionWorker: BackgroundProjectionWorker
): void {
  let stopping = false;
  const stop = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.info(JSON.stringify({ event: "runner.shutdown_started", role: "core", signal }));
    processGroupMemory.stop();
    projectionWorker.stop();
    server.stop(true);
    await Promise.all(Object.values(providers).map(async (provider) => {
      const stopProvider = (provider as { stop?: () => Promise<void> } | undefined)?.stop;
      if (stopProvider) await stopProvider.call(provider).catch(() => {});
    }));
    readDatabase.close();
    database.close();
    process.exit(0);
  };
  process.on("SIGINT", () => { void stop("SIGINT"); });
  process.on("SIGTERM", () => { void stop("SIGTERM"); });
}

async function startAutoRunLoops(
  database: Awaited<ReturnType<typeof openDatabase>>,
  providers: ReturnType<typeof executorProviders>,
  bus: EventBus,
  codexSessionsDir: string,
  config: ReturnType<typeof loadConfig>,
  processReconciliation: Awaited<ReturnType<typeof reconcileStaleCodexProcessOwnership>>
): Promise<void> {
  await recoverInProgressIssues({ database, providers }).catch((error) => {
    console.error(JSON.stringify({ ok: false, service: "codex-issue-runner backend-ts", error: safeError(error) }));
  });
  reconcileStaleAgentSessions(database, processReconciliation);
  const projects = database.sqlite.query<{ id: string }, []>(
    "select id from projects where auto_run=1 order by sort_order asc, created_at asc, id asc"
  ).all();
  for (const project of projects) startProjectLoop({ bus, database, providers, onError: logProjectLoopError }, project.id);
  createPiAutoManageScheduler({
    bus,
    codexSessionsDir,
    config,
    database,
    providers,
    onError: (error) => {
      console.error(JSON.stringify({ ok: false, service: "codex-issue-runner backend-ts", error: safeError(error) }));
    },
    runProjectCycle: ({ maxActions, projectId }) => runProjectPiCycle({ database }, { maxActions, projectId })
  }).start();
}

function logProjectLoopError(error: unknown, projectId: string): void {
  console.error(JSON.stringify({ ok: false, service: "codex-issue-runner backend-ts", projectId, error: safeError(error) }));
}

async function restartFeishuReceiver(feishuConfig: FeishuConnectorConfig): Promise<void> {
  await activeFeishuReceiver?.restart(feishuConfig).catch((error) => {
    console.error(JSON.stringify({ ok: false, service: "codex-issue-runner backend-ts", connector: "feishu", error: safeError(error) }));
  });
}

function safeError(error: unknown): string {
  return redactSensitiveText(error instanceof Error ? error.message : String(error));
}
