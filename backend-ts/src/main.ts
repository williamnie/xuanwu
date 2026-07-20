import { formatBunVersion } from "./buildInfo.ts";
import { join } from "node:path";
import { coldStartTrace } from "./benchmarks/coldStart.ts";
import { commandMode } from "./mainMode.ts";
import { loadConfig } from "./config/env.ts";
import { openDatabase } from "./db/database.ts";
import { EventBus } from "./events/bus.ts";
import { runProjectPiCycle } from "./http/piProjectControlApi.ts";
import { startServer } from "./http/server.ts";
import type { FeishuConnectorConfig } from "./integrations/feishu.ts";
import { createFeishuAgentBridge } from "./integrations/feishuAgentBridge.ts";
import { createFeishuReceiverManager } from "./integrations/feishuReceiver.ts";
import { createClaudeExecutorProvider } from "./providers/claude/provider.ts";
import { createCodexExecutorProvider } from "./providers/codex/provider.ts";
import { reconcileStaleCodexProcessOwnership } from "./providers/codex/processLifecycle.ts";
import { createPiAutoManageScheduler } from "./runner/piAutoManageScheduler.ts";
import { setProjectLoopMaxParallelProjects, startProjectLoop } from "./runner/projectLoopManager.ts";
import { recoverInProgressIssues } from "./runner/recovery.ts";
import { reconcileStaleAgentSessions } from "./runner/staleSessionReconciler.ts";
import { redactSensitiveText } from "./util/redact.ts";
import { ProcessGroupMemoryObserver, writeProcessGroupMemoryAlert } from "./observability/processGroupMemory.ts";

if (Bun.argv[2] === "__usage-index-worker") {
  const [, root = "", indexPath = "", forceRebuild = "0", parentPIDText = "0"] = Bun.argv.slice(2);
  const parentPID = Number(parentPIDText);
  const parentWatch = setInterval(() => {
    if (!Number.isInteger(parentPID) || parentPID <= 1) return;
    try { process.kill(parentPID, 0); } catch { process.exit(1); }
  }, 1000);
  try {
    const { refreshUsageIndex } = await import("./usage/usageIndex.ts");
    const metrics = await refreshUsageIndex(root, indexPath, { forceRebuild: forceRebuild === "1" });
    clearInterval(parentWatch);
    process.stdout.write(JSON.stringify({ metrics, ok: true }));
    process.exit(0);
  } catch (error) {
    clearInterval(parentWatch);
    process.stderr.write(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

const { serve, args, version } = commandMode(Bun.argv.slice(2));
coldStartTrace("entry_loaded");

if (version) {
  process.stdout.write(formatBunVersion());
  process.exit(0);
}

if (!serve) {
  const { runCli } = await import("./cli/command.ts");
  process.exit(await runCli(args));
}

const config = loadConfig(args);
coldStartTrace("config_loaded");
const database = await openDatabase({ dbPath: config.dbPath, stateDir: config.stateDir });
coldStartTrace("database_opened");
const bus = new EventBus();
const codexOwnershipFile = join(config.stateDir, "codex-process-ownership.json");
const processReconciliation = await reconcileStaleCodexProcessOwnership(codexOwnershipFile);
const providers = executorProviders(config, bus, codexOwnershipFile);
const processGroupMemory = new ProcessGroupMemoryObserver({
  activeRuns: () => database.sqlite.query<{ count: number }, []>(
    "select count(*) as count from issue_runs where ended_at=''"
  ).get()?.count ?? 0,
  onAlert: (alert) => writeProcessGroupMemoryAlert(database, alert),
  providerRuntime: () => (providers.codex as ReturnType<typeof createCodexExecutorProvider> | undefined)?.runtimeSnapshot()
});
processGroupMemory.start();
const sessionReconciliation = reconcileStaleAgentSessions(database, processReconciliation);
coldStartTrace("providers_initialized");
setProjectLoopMaxParallelProjects(config.runner.maxParallelProjects);
const feishuBridge = createFeishuAgentBridge({
  config: () => config.integrations.feishu,
  database,
  runConversation: async ({ conversationId, event, intent, projectId, prompt, targetProjectId, targetProjectSource }) => {
    const { runPiConversationPrompt } = await import("./http/piConversationApi.ts");
    const oneShotTargetProjectId = targetProjectId || projectId;
    const result = await runPiConversationPrompt({ bus, database, providers }, {
      clearProjectId: true,
      conversationId,
      intent,
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
coldStartTrace("connectors_initialized");
const server = await startServer(config, {
  bus,
  database,
  feishuAgentBridge: feishuBridge,
  feishuReceiverStatus: () => feishuReceiver.status(),
  onFeishuConfigChanged: restartFeishuReceiver,
  processGroupMemory,
  providers
});
installTerminationHandlers(providers, database, server, processGroupMemory);
coldStartTrace("http_routes_registered");
void restartFeishuReceiver(config.integrations.feishu);
void startAutoRunLoops(database, providers, bus, config.codexSessionsDir, config, processReconciliation);
coldStartTrace("scheduler_watchdog_initialized");

console.log(JSON.stringify({
  ok: true,
  service: "codex-issue-runner backend-ts",
  listen: `${server.hostname}:${server.port}`,
  config: {
    addr: config.addr,
    stateDir: config.stateDir,
    dbPath: database.path
  },
  lifecycle_reconciliation: sessionReconciliation
}, null, 2));

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
  server: { stop(closeActiveConnections?: boolean): void },
  processGroupMemory: ProcessGroupMemoryObserver
): void {
  let stopping = false;
  const stop = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.info(JSON.stringify({ event: "runner.shutdown_started", signal }));
    processGroupMemory.stop();
    server.stop(true);
    await Promise.all(Object.values(providers).map(async (provider) => {
      const stopProvider = (provider as { stop?: () => Promise<void> } | undefined)?.stop;
      if (stopProvider) await stopProvider.call(provider).catch(() => {});
    }));
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
  await feishuReceiver.restart(feishuConfig).catch((error) => {
    console.error(JSON.stringify({ ok: false, service: "codex-issue-runner backend-ts", connector: "feishu", error: safeError(error) }));
  });
}

function safeError(error: unknown): string {
  return redactSensitiveText(error instanceof Error ? error.message : String(error));
}
