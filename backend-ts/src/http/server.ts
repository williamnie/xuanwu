import type { RunnerConfig } from "../config/env.ts";
import { EventBus } from "../events/bus.ts";
import type { RunnerDatabase } from "../db/database.ts";
import type { ExecutorProvider, ExecutorProviderId } from "../providers/types.ts";
import { loadAuthToken, requireBearerAuth } from "./auth.ts";
import { applyLocalCors, withCors } from "./cors.ts";
import { registerEventRoutes } from "./events.ts";
import { buildFeishuConnectorConfig } from "../integrations/feishu.ts";
import { attachFeishuNotificationObservers } from "../integrations/feishuNotifications.ts";
import { attachPiIssueCompletionWatchObserver } from "../pi/issueCompletionWatchEvaluator.ts";
import { json } from "./errors.ts";
import { registerExternalEventRoutes } from "./externalEventsApi.ts";
import { registerFeishuEventRoutes } from "./feishuEventsApi.ts";
import { registerFeishuSettingsRoutes } from "./feishuSettingsApi.ts";
import { registerImReplyOutboxRoutes } from "./imReplyOutboxApi.ts";
import type { FeishuMessageSender } from "../pi/imReplyOutboxDispatcher.ts";
import type { createFeishuAgentBridge } from "../integrations/feishuAgentBridge.ts";
import type { PiOpenAICodexOAuthLogin } from "./piOAuthApi.ts";
import { registerReadApiRoutes } from "./readApi.ts";
import { registerRunnerSettingsRoutes } from "./runnerSettingsApi.ts";
import { createRouter, type Router } from "./router.ts";
import { buildRuntimeLogs, runtimeLogLineLimit } from "./systemLogs.ts";
import { staticWebResponse } from "./staticWeb.ts";
import { buildPiGuardianSystemStatus } from "./piGuardianStatus.ts";
import { buildRuntimeDoctor, buildSystemStatus } from "./systemStatus.ts";
import { registerSystemRestartRoute } from "./systemRestartApi.ts";
import { setProjectLoopMaxParallelProjects } from "../runner/projectLoopManager.ts";
import type { FeishuConnectorConfig } from "../integrations/feishu.ts";
import type { FeishuReceiverStatus } from "../integrations/feishuReceiver.ts";

type ListenAddress = { hostname: string; port: number };
type ServerRuntime = DefaultRouterOptions & { database: RunnerDatabase; startedAt?: Date };
type DefaultRouterOptions = {
  bus?: EventBus;
  codexSessionsDir?: string;
  config?: RunnerConfig;
  database?: RunnerDatabase;
  feishuReceiverStatus?: () => FeishuReceiverStatus;
  interruptTimeoutMs?: number;
  onFeishuConfigChanged?: (config: FeishuConnectorConfig) => Promise<void> | void;
  feishuAgentBridge?: ReturnType<typeof createFeishuAgentBridge>;
  feishuSender?: FeishuMessageSender;
  piOpenAICodexOAuthLogin?: PiOpenAICodexOAuthLogin;
  providers?: Partial<Record<ExecutorProviderId, ExecutorProvider>>;
  restartDelayMs?: number;
  restartProcess?: () => void;
};

export function createDefaultRouter(runtime: DefaultRouterOptions = {}): Router {
  if (runtime.config) setProjectLoopMaxParallelProjects(runtime.config.runner.maxParallelProjects);
  const router = createRouter();
  const bus = runtime.bus ?? new EventBus();
  router.get("/health", () => json({ status: "ok" }));
  registerSystemRestartRoute(router, {
    providers: runtime.providers,
    restartDelayMs: runtime.restartDelayMs,
    restartProcess: runtime.restartProcess
  });
  registerEventRoutes(router, { bus });
  registerFeishuEventRoutes(router, {
    agentBridge: runtime.feishuAgentBridge,
    bus,
    config: runtime.config?.integrations.feishu ?? buildFeishuConnectorConfig(),
    database: runtime.database,
    providers: runtime.providers
  });
  if (runtime.database) {
    attachPiIssueCompletionWatchObserver({ bus, database: runtime.database });
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
    registerImReplyOutboxRoutes(router, {
      config: runtime.config?.integrations.feishu,
      database: runtime.database,
      feishuSender: runtime.feishuSender
    });
    registerReadApiRoutes(router, {
      bus,
      codexSessionsDir: runtime.codexSessionsDir,
      config: runtime.config,
      database: runtime.database,
      interruptTimeoutMs: runtime.interruptTimeoutMs,
      piOpenAICodexOAuthLogin: runtime.piOpenAICodexOAuthLogin,
      providers: runtime.providers
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
  registerSystemStatusRoute(activeRouter, { authToken, config, ...runtime });
  registerSystemLogsRoute(activeRouter, { config });
  return Bun.serve({
    hostname: address.hostname,
    idleTimeout: 120,
    port: address.port,
    fetch: createRequestHandler(activeRouter, authToken, { webDir: config.webDir })
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
    database: context.database,
    feishuReceiverStatus: context.feishuReceiverStatus,
    startedAt
  };
  router.get("/api/system/status", () => json({
    ...buildSystemStatus(statusContext),
    pi_guardian: buildPiGuardianSystemStatus(context.database)
  }));
  router.get("/api/system/doctor", () => json(buildRuntimeDoctor(statusContext)));
}

type RequestHandlerOptions = { webDir?: string };

export function createRequestHandler(
  router: Router,
  authToken: string,
  options: RequestHandlerOptions = {}
): (request: Request) => Promise<Response> {
  return async (request) => {
    const corsResponse = applyLocalCors(request);
    if (corsResponse) return corsResponse;
    const response = requireBearerAuth(request, authToken) ?? await routeOrStatic(router, request, options);
    return withCors(request, response);
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

export function parseListenAddress(addr: string): ListenAddress {
  const trimmed = addr.trim();
  const separator = trimmed.lastIndexOf(":");
  if (separator <= 0) throw new Error(`Invalid listen address: ${addr}`);
  const hostname = trimmed.slice(0, separator);
  const port = Number(trimmed.slice(separator + 1));
  if (!Number.isInteger(port) || port <= 0) throw new Error(`Invalid listen port: ${addr}`);
  return { hostname, port };
}
