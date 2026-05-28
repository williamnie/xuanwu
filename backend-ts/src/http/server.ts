import type { RunnerConfig } from "../config/env.ts";
import { EventBus } from "../events/bus.ts";
import type { RunnerDatabase } from "../db/database.ts";
import { loadAuthToken, requireBearerAuth } from "./auth.ts";
import { applyLocalCors, withCors } from "./cors.ts";
import { registerEventRoutes } from "./events.ts";
import { json } from "./errors.ts";
import { registerReadApiRoutes } from "./readApi.ts";
import { createRouter, type Router } from "./router.ts";
import { buildSystemStatus } from "./systemStatus.ts";

type ListenAddress = { hostname: string; port: number };
type ServerRuntime = { bus?: EventBus; database: RunnerDatabase; startedAt?: Date };
type DefaultRouterOptions = { bus?: EventBus; database?: RunnerDatabase };

export function createDefaultRouter(runtime: DefaultRouterOptions = {}): Router {
  const router = createRouter();
  router.get("/health", () => json({ status: "ok" }));
  registerEventRoutes(router, { bus: runtime.bus ?? new EventBus() });
  if (runtime.database) registerReadApiRoutes(router, { database: runtime.database });
  return router;
}

export async function startServer(
  config: RunnerConfig,
  runtime: ServerRuntime,
  router = createDefaultRouter(runtime)
): Promise<ReturnType<typeof Bun.serve>> {
  const address = parseListenAddress(config.addr);
  const authToken = await loadAuthToken(config);
  registerSystemStatusRoute(router, { authToken, config, ...runtime });
  return Bun.serve({
    hostname: address.hostname,
    port: address.port,
    fetch: createRequestHandler(router, authToken)
  });
}

export function registerSystemStatusRoute(
  router: Router,
  context: ServerRuntime & { authToken: string; config: RunnerConfig }
): void {
  const startedAt = context.startedAt ?? new Date();
  router.get("/api/system/status", () => json(buildSystemStatus({
    authEnabled: context.authToken.trim() !== "",
    config: context.config,
    database: context.database,
    startedAt
  })));
}

export function createRequestHandler(router: Router, authToken: string): (request: Request) => Promise<Response> {
  return async (request) => {
    const corsResponse = applyLocalCors(request);
    if (corsResponse) return corsResponse;
    const response = requireBearerAuth(request, authToken) ?? await router.handle(request);
    return withCors(request, response);
  };
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
