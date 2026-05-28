import type { RunnerConfig } from "../config/env.ts";
import type { RunnerDatabase } from "../db/database.ts";
import { loadAuthToken, requireBearerAuth } from "./auth.ts";
import { json } from "./errors.ts";
import { createRouter, type Router } from "./router.ts";
import { buildSystemStatus } from "./systemStatus.ts";

type ListenAddress = { hostname: string; port: number };
type ServerRuntime = { database: RunnerDatabase; startedAt?: Date };

export function createDefaultRouter(): Router {
  const router = createRouter();
  router.get("/health", () => json({ status: "ok" }));
  return router;
}

export async function startServer(
  config: RunnerConfig,
  runtime: ServerRuntime,
  router = createDefaultRouter()
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
  return async (request) => requireBearerAuth(request, authToken) ?? await router.handle(request);
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
