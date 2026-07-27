import type { RunnerConfig } from "../config/env.ts";
import type { AgenticWorkerClient } from "../agentic/protocol.ts";
import { parseListenAddress } from "../config/listenAddress.ts";
import { EventBus } from "../events/bus.ts";
import type { RunnerDatabase } from "../db/database.ts";
import type { ExecutorProvider, ExecutorProviderId } from "../providers/types.ts";
import { loadAuthToken, requireBearerAuth } from "./auth.ts";
import { applyLocalCors, withCors } from "./cors.ts";
import { registerEventRoutes } from "./events.ts";
import { buildFeishuConnectorConfig } from "../integrations/feishu.ts";
import { attachFeishuNotificationObservers } from "../integrations/feishuNotifications.ts";
import { json, jsonError } from "./errors.ts";
import { registerExternalEventRoutes } from "./externalEventsApi.ts";
import { registerFeishuEventRoutes } from "./feishuEventsApi.ts";
import { registerFeishuSettingsRoutes } from "./feishuSettingsApi.ts";
import { registerImReplyOutboxRoutes } from "./imReplyOutboxApi.ts";
import { registerWebhookEventRoutes } from "./webhookEventsApi.ts";
import { registerGitEventRoutes } from "./gitEventsApi.ts";
import { registerTrackerEventRoutes } from "./trackerEventsApi.ts";
import type { FeishuMessageSender } from "../pi/imReplyOutboxDispatcher.ts";
import type { createFeishuAgentBridge } from "../integrations/feishuAgentBridge.ts";
import type { PiOpenAICodexOAuthLogin } from "./piOAuthApi.ts";
import type { EventRouterSourcePolicy } from "../pi/eventRouter.ts";
import type { LlmIntakeModel } from "../pi/llmIntake.ts";
import { registerReadApiRoutes } from "./readApi.ts";
import { instrumentLegacyCompatibilityResponse } from "./legacyCompatibilityApi.ts";
import { registerRunnerSettingsRoutes } from "./runnerSettingsApi.ts";
import { createRouter, type Router } from "./router.ts";
import { buildRuntimeLogs, runtimeLogLineLimit } from "./systemLogs.ts";
import { staticWebResponse } from "./staticWeb.ts";
import { buildPiGuardianSystemStatus } from "./piGuardianStatus.ts";
import { buildCompactSystemStatus, buildRuntimeDoctor, buildSystemStatus } from "./systemStatus.ts";
import { registerSystemRestartRoute, type SystemRestartAuditEvent } from "./systemRestartApi.ts";
import { setProjectLoopMaxParallelProjects } from "../runner/projectLoopManager.ts";
import type { FeishuConnectorConfig } from "../integrations/feishu.ts";
import type { FeishuReceiverStatus } from "../integrations/feishuReceiver.ts";

type ServerRuntime = DefaultRouterOptions & { database: RunnerDatabase; startedAt?: Date };
type DefaultRouterOptions = {
  agenticClient?: AgenticWorkerClient;
  auditSystemRestart?: (event: SystemRestartAuditEvent) => void;
  bus?: EventBus;
  codexSessionsDir?: string;
  config?: RunnerConfig;
  database?: RunnerDatabase;
  readDatabase?: RunnerDatabase;
  feishuReceiverStatus?: () => FeishuReceiverStatus;
  interruptTimeoutMs?: number;
  onFeishuConfigChanged?: (config: FeishuConnectorConfig) => Promise<void> | void;
  feishuAgentBridge?: ReturnType<typeof createFeishuAgentBridge>;
  feishuIntakeModel?: LlmIntakeModel;
  feishuIntakePolicy?: EventRouterSourcePolicy;
  feishuSender?: FeishuMessageSender;
  piOpenAICodexOAuthLogin?: PiOpenAICodexOAuthLogin;
  processGroupMemory?: { snapshot(): Record<string, unknown> };
  projectionWorker?: { snapshot(): Record<string, unknown> };
  providers?: Partial<Record<ExecutorProviderId, ExecutorProvider>>;
  restartDelayMs?: number;
  restartProcess?: () => void;
  role?: "all" | "core";
  supervisorManaged?: boolean;
  testBlockMs?: number;
  webhookSigningSecret?: string;
};

export function createDefaultRouter(runtime: DefaultRouterOptions = {}): Router {
  if (runtime.config) setProjectLoopMaxParallelProjects(runtime.config.runner.maxParallelProjects);
  const router = createRouter();
  const bus = runtime.bus ?? new EventBus();
  router.get("/health", () => json({ status: "ok" }));
  if (runtime.agenticClient) {
    router.get("/api/system/agentic-health", async () => {
      try {
        return json(await runtime.agenticClient!.health());
      } catch {
        return jsonError(503, "Agentic Worker unavailable");
      }
    });
  }
  registerSystemRestartRoute(router, {
    audit: runtime.auditSystemRestart,
    providers: runtime.providers,
    restartDelayMs: runtime.restartDelayMs,
    restartProcess: runtime.restartProcess,
    supervisorManaged: runtime.supervisorManaged
  });
  registerEventRoutes(router, { bus });
  registerFeishuEventRoutes(router, {
    agentBridge: runtime.feishuAgentBridge,
    bus,
    config: runtime.config?.integrations.feishu ?? buildFeishuConnectorConfig(),
    database: runtime.database,
    feishuIntakeModel: runtime.feishuIntakeModel,
    feishuIntakePolicy: runtime.feishuIntakePolicy,
    providers: runtime.providers
  });
  if (runtime.database) {
    attachFeishuNotificationObservers({
      bus,
      config: runtime.config?.integrations.feishu,
      database: runtime.database,
      sender: runtime.feishuSender
    });
    registerFeishuSettingsRoutes(router, {
      config: runtime.config,
      database: runtime.database,
      onConfigChanged: runtime.onFeishuConfigChanged
    });
    registerRunnerSettingsRoutes(router, {
      bus,
      config: runtime.config,
      database: runtime.database,
      providers: runtime.providers
    });
    registerExternalEventRoutes(router, { database: runtime.database });
    registerWebhookEventRoutes(router, {
      database: runtime.database,
      signingSecret: runtime.webhookSigningSecret
    });
    registerGitEventRoutes(router, { database: runtime.database });
    registerTrackerEventRoutes(router, { database: runtime.database });
    registerImReplyOutboxRoutes(router, {
      config: runtime.config?.integrations.feishu,
      database: runtime.database,
      feishuSender: runtime.feishuSender
    });
    registerReadApiRoutes(router, {
      agenticClient: runtime.agenticClient,
      bus,
      codexSessionsDir: runtime.codexSessionsDir,
      config: runtime.config,
      database: runtime.database,
      readDatabase: runtime.readDatabase,
      interruptTimeoutMs: runtime.interruptTimeoutMs,
      piOpenAICodexOAuthLogin: runtime.piOpenAICodexOAuthLogin,
      providers: runtime.providers,
      webhookSigningSecret: runtime.webhookSigningSecret
    });
  }
  return router;
}

export async function startServer(
  config: RunnerConfig,
  runtime: ServerRuntime,
  router?: Router
): Promise<ReturnType<typeof Bun.serve>> {
  const address = parseListenAddress(config.addr);
  const authToken = await loadAuthToken(config);
  const activeRouter = router ?? createDefaultRouter({ ...runtime, codexSessionsDir: config.codexSessionsDir, config });
  registerControlledBlockRoute(activeRouter, runtime.testBlockMs ?? Number(Bun.env.CODEX_RUNNER_TEST_BLOCK_MS ?? "0"));
  registerSystemStatusRoute(activeRouter, { authToken, config, ...runtime });
  registerSystemLogsRoute(activeRouter, { config });
  return Bun.serve({
    hostname: address.hostname,
    idleTimeout: 120,
    port: address.port,
    fetch: createRequestHandler(activeRouter, authToken, { database: runtime.database, webDir: config.webDir })
  });
}

export function registerSystemLogsRoute(router: Router, context: { config: RunnerConfig }): void {
  router.get("/api/system/logs", async (request) => json(
    await buildRuntimeLogs(context.config, runtimeLogLineLimit(request))
  ));
}

export function registerSystemStatusRoute(
  router: Router,
  context: ServerRuntime & { authToken: string; config: RunnerConfig }
): void {
  const startedAt = context.startedAt ?? new Date();
  const statusContext = {
    authEnabled: context.authToken.trim() !== "",
    config: context.config,
    database: context.readDatabase ?? context.database,
    feishuReceiverStatus: context.feishuReceiverStatus,
    processGroupMemory: context.processGroupMemory,
    projectionWorker: context.projectionWorker,
    role: context.role ?? "all",
    startedAt,
    webhookSigningSecret: context.webhookSigningSecret
  };
  router.get("/api/system/status", (request) => json({
    ...(new URL(request.url).searchParams.get("compact") === "1"
      ? buildCompactSystemStatus(statusContext)
      : buildSystemStatus(statusContext)),
    pi_guardian: buildPiGuardianSystemStatus(context.readDatabase ?? context.database)
  }));
  router.get("/api/system/doctor", () => json(buildRuntimeDoctor(statusContext)));
}

export function registerControlledBlockRoute(router: Router, blockMs: number): void {
  if (!Number.isInteger(blockMs) || blockMs <= 0) return;
  const boundedMs = Math.min(blockMs, 30_000);
  router.get(CONTROLLED_BLOCK_PATH, () => {
    Bun.sleepSync(boundedMs);
    return json({ blocked_ms: boundedMs, ok: true });
  });
}

type RequestHandlerOptions = { database?: RunnerDatabase; webDir?: string };
const CONTROLLED_BLOCK_PATH = "/api/system/test/block";

export function createRequestHandler(
  router: Router,
  authToken: string,
  options: RequestHandlerOptions = {}
): (request: Request) => Promise<Response> {
  return async (request) => {
    const corsResponse = applyLocalCors(request);
    if (corsResponse) return corsResponse;
    const response = requireBearerAuth(request, authToken) ?? await routeOrStatic(router, request, options);
    return withCors(request, instrumentLegacyCompatibilityResponse(request, response, options.database));
  };
}

async function routeOrStatic(router: Router, request: Request, options: RequestHandlerOptions): Promise<Response> {
  const response = await router.handle(request);
  if (!shouldTryStaticWeb(request, response, options.webDir)) return response;
  return await staticWebResponse(request, options.webDir ?? "") ?? response;
}

function shouldTryStaticWeb(request: Request, response: Response, webDir: string | undefined): boolean {
  return response.status === 404 && clean(webDir) !== "" && !isApiPath(request);
}

function isApiPath(request: Request): boolean {
  return new URL(request.url).pathname.startsWith("/api/");
}

function clean(value: string | undefined): string {
  return value?.trim() ?? "";
}
