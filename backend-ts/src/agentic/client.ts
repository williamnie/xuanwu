import {
  AGENTIC_COMMUNICATION_DECISION_PATH,
  AGENTIC_HEALTH_PATH,
  AGENTIC_PROJECT_CYCLE_PATH,
  AGENTIC_SUPERVISOR_DECISION_PATH,
  type AgenticCommunicationDecisionRequest,
  type AgenticCommunicationDecisionResult,
  type AgenticProjectCycleRequest,
  type AgenticProjectCycleResult,
  type AgenticRpcResponse,
  type AgenticSupervisorDecisionResult,
  type AgenticWorkerClient
} from "./protocol.ts";

// Manager cycles can legitimately run for several minutes. Keep the HTTP
// boundary bounded, but leave enough headroom for a normal PI turn to finish.
const MAX_AGENTIC_TIMEOUT_MS = 240_000;
const DEFAULT_AGENTIC_TIMEOUT_MS = MAX_AGENTIC_TIMEOUT_MS;

export function createHttpAgenticWorkerClient(input: {
  addr: string;
  authToken?: string;
  timeoutMs?: number;
}): AgenticWorkerClient {
  const baseUrl = normalizeAddress(input.addr);
  const timeoutMs = positiveTimeout(input.timeoutMs);
  return {
    decideCommunication: (body) => post<AgenticCommunicationDecisionResult>(
      baseUrl, AGENTIC_COMMUNICATION_DECISION_PATH, body, input.authToken, timeoutMs
    ),
    decideSupervisor: (context) => post<AgenticSupervisorDecisionResult>(
      baseUrl, AGENTIC_SUPERVISOR_DECISION_PATH, { context }, input.authToken, timeoutMs
    ),
    async health() {
      const response = await fetchWithTimeout(`${baseUrl}${AGENTIC_HEALTH_PATH}`, {
        headers: authorizationHeaders(input.authToken)
      }, Math.min(timeoutMs, 5_000));
      if (!response.ok) throw new Error(`Agentic Worker health failed: HTTP ${response.status}`);
      const body = await response.json() as { ok?: unknown; role?: unknown };
      if (body.ok !== true || body.role !== "agentic") throw new Error("Agentic Worker returned an invalid health response");
      return { ok: true, role: "agentic" };
    },
    runProjectCycle: (body) => post<AgenticProjectCycleResult>(
      baseUrl, AGENTIC_PROJECT_CYCLE_PATH, body, input.authToken, timeoutMs
    )
  };
}

async function post<T>(
  baseUrl: string,
  path: string,
  body: AgenticCommunicationDecisionRequest | AgenticProjectCycleRequest | Record<string, unknown>,
  authToken: string | undefined,
  timeoutMs: number
): Promise<T> {
  const response = await fetchWithTimeout(`${baseUrl}${path}`, {
    body: JSON.stringify(body),
    headers: { ...authorizationHeaders(authToken), "content-type": "application/json" },
    method: "POST"
  }, timeoutMs);
  const payload = await response.json().catch(() => null) as AgenticRpcResponse<T> | null;
  if (!response.ok || !payload || payload.ok !== true) {
    const detail = payload && "error" in payload ? payload.error : `HTTP ${response.status}`;
    throw new Error(`Agentic Worker request failed: ${detail}`);
  }
  return payload.result;
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`Agentic Worker request timed out after ${timeoutMs}ms`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function authorizationHeaders(token: string | undefined): Record<string, string> {
  const clean = token?.trim() ?? "";
  return clean === "" ? {} : { authorization: `Bearer ${clean}` };
}

function normalizeAddress(value: string): string {
  const clean = value.trim().replace(/\/+$/, "");
  return /^https?:\/\//i.test(clean) ? clean : `http://${clean}`;
}

function positiveTimeout(value: number | undefined): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? Math.min(value, MAX_AGENTIC_TIMEOUT_MS)
    : DEFAULT_AGENTIC_TIMEOUT_MS;
}
