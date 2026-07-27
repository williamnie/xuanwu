import type { RunnerConfig } from "../config/env.ts";
import type { RunnerDatabase } from "../db/database.ts";
import { getPiSupervisor } from "../db/repositories/pi.ts";
import { getProject } from "../db/repositories/projects.ts";
import { HttpError } from "../http/errors.ts";
import { loadAuthToken, requireBearerAuth } from "../http/auth.ts";
import { runProjectPiCycle } from "../http/piProjectControlApi.ts";
import { parseListenAddress } from "../config/listenAddress.ts";
import { decideAgentCommunicationWithRuntime } from "../notifications/agentCommunicationGateway.ts";
import { runPiSupervisorDecision } from "../pi/issueSupervisorDecision.ts";
import { redactSensitiveText } from "../util/redact.ts";
import {
  AGENTIC_COMMUNICATION_DECISION_PATH,
  AGENTIC_HEALTH_PATH,
  AGENTIC_PROJECT_CYCLE_PATH,
  AGENTIC_SUPERVISOR_DECISION_PATH,
  type AgenticCommunicationDecisionRequest,
  type AgenticProjectCycleRequest,
  type AgenticRpcResponse,
  type AgenticSupervisorDecisionRequest
} from "./protocol.ts";
import { createAgenticIdleMemoryReclaimer } from "./activity.ts";

const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
const AGENTIC_STARTED_AT = new Date().toISOString();

export async function startAgenticServer(config: RunnerConfig, database: RunnerDatabase) {
  const address = parseListenAddress(config.addr);
  const authToken = await loadAuthToken(config);
  const idleMemory = createAgenticIdleMemoryReclaimer();
  return Bun.serve({
    hostname: address.hostname,
    idleTimeout: 255,
    port: address.port,
    fetch: async (request) => {
      const auth = requireBearerAuth(request, authToken);
      if (auth) return auth;
      const tracksActivity = request.method === "POST";
      if (tracksActivity) idleMemory.requestStarted();
      try {
        return await routeAgenticRequest(database, request);
      } catch (error) {
        const status = error instanceof HttpError ? error.status : 500;
        return rpcResponse({ error: safeError(error), ok: false }, status);
      } finally {
        if (tracksActivity) idleMemory.requestFinished();
      }
    }
  });
}

export async function routeAgenticRequest(db: RunnerDatabase, request: Request): Promise<Response> {
  const path = new URL(request.url).pathname;
  if (request.method === "GET" && path === AGENTIC_HEALTH_PATH) {
    return agenticResponse({ ok: true, role: "agentic" });
  }
  if (request.method !== "POST") return rpcResponse({ error: "not found", ok: false }, 404);
  if (path === AGENTIC_PROJECT_CYCLE_PATH) {
    const input = await requestBody<AgenticProjectCycleRequest>(request);
    const result = await runProjectPiCycle({ database: db }, {
      maxActions: positiveInteger(input.maxActions, 5),
      projectId: requiredString(input.projectId, "projectId")
    });
    return rpcResponse({ ok: true, result });
  }
  if (path === AGENTIC_COMMUNICATION_DECISION_PATH) {
    const input = await requestBody<AgenticCommunicationDecisionRequest>(request);
    const intents = Array.isArray(input.intents) ? input.intents : [];
    const now = new Date(String(input.now));
    if (intents.length === 0 || !Number.isFinite(now.getTime())) throw new HttpError(400, "invalid communication decision input");
    const result = await decideAgentCommunicationWithRuntime(db, { intents, now });
    return rpcResponse({ ok: true, result });
  }
  if (path === AGENTIC_SUPERVISOR_DECISION_PATH) {
    const input = await requestBody<AgenticSupervisorDecisionRequest>(request);
    const context = input.context;
    const projectID = requiredString(context?.project?.id, "context.project.id");
    const agent = getPiSupervisor(db);
    if (!agent || agent.enabled !== 1) throw new HttpError(503, "configured Supervisor is unavailable");
    const project = getProject(db, projectID);
    if (!project) throw new HttpError(404, `Supervisor project is unavailable: ${projectID}`);
    const result = await runPiSupervisorDecision({ agent, context, database: db, project });
    return rpcResponse({ ok: true, result });
  }
  return rpcResponse({ error: "not found", ok: false }, 404);
}

async function requestBody<T>(request: Request): Promise<T> {
  const length = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(length) && length > MAX_REQUEST_BYTES) throw new HttpError(413, "agentic request too large");
  const text = await request.text();
  if (Buffer.byteLength(text) > MAX_REQUEST_BYTES) throw new HttpError(413, "agentic request too large");
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("object required");
    return parsed as T;
  } catch {
    throw new HttpError(400, "invalid agentic request JSON");
  }
}

function rpcResponse<T>(body: AgenticRpcResponse<T>, status = 200): Response {
  return agenticResponse(body, status);
}

function agenticResponse(body: unknown, status = 200): Response {
  return Response.json(body, { headers: agenticRuntimeHeaders(), status });
}

function agenticRuntimeHeaders(): Record<string, string> {
  return {
    "x-codex-runner-agentic-pid": String(process.pid),
    "x-codex-runner-agentic-rss-bytes": String(process.memoryUsage.rss()),
    "x-codex-runner-agentic-started-at": AGENTIC_STARTED_AT
  };
}

function requiredString(value: unknown, label: string): string {
  const clean = typeof value === "string" ? value.trim() : "";
  if (clean === "") throw new HttpError(400, `${label} is required`);
  return clean;
}

function positiveInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? Math.min(value, 100) : fallback;
}

function safeError(error: unknown): string {
  return redactSensitiveText(error instanceof Error ? error.message : String(error));
}
