import {
  AGENTIC_COMMUNICATION_DECISION_PATH,
  AGENTIC_HEALTH_PATH,
  AGENTIC_ISSUE_ACCEPTANCE_PATH,
  AGENTIC_PROJECT_CYCLE_PATH,
  AGENTIC_SUPERVISOR_DECISION_PATH,
  type AgenticCommunicationDecisionRequest,
  type AgenticCommunicationDecisionResult,
  type AgenticIssueAcceptanceResult,
  type AgenticProjectCycleRequest,
  type AgenticProjectCycleResult,
  type AgenticRpcResponse,
  type AgenticSupervisorDecisionResult,
  type AgenticWorkerClient
} from "./protocol.ts";
import { createAgenticActivityTracker } from "./activity.ts";

// Manager cycles can legitimately run for several minutes. Keep the HTTP
// boundary bounded, but leave enough headroom for a normal PI turn to finish.
const MAX_AGENTIC_TIMEOUT_MS = 240_000;
const DEFAULT_AGENTIC_TIMEOUT_MS = MAX_AGENTIC_TIMEOUT_MS;

export function createHttpAgenticWorkerClient(input: {
  addr: string;
  authToken?: string;
  authTokenProvider?: () => string | Promise<string>;
  now?: () => Date;
  timeoutMs?: number;
}): AgenticWorkerClient {
  const baseUrl = normalizeAddress(input.addr);
  const timeoutMs = positiveTimeout(input.timeoutMs);
  const activity = createAgenticActivityTracker(input.now);
  return {
    activity: activity.snapshot,
    decideCommunication: (body) => activity.run(() => post<AgenticCommunicationDecisionResult>(
      baseUrl, AGENTIC_COMMUNICATION_DECISION_PATH, body, authToken(input), timeoutMs, activity.observeWorker
    )),
    decideIssueAcceptance: (card) => activity.run(() => post<AgenticIssueAcceptanceResult>(
      baseUrl, AGENTIC_ISSUE_ACCEPTANCE_PATH, { card }, authToken(input), timeoutMs, activity.observeWorker
    )),
    decideSupervisor: (context) => activity.run(() => post<AgenticSupervisorDecisionResult>(
      baseUrl, AGENTIC_SUPERVISOR_DECISION_PATH, { context }, authToken(input), timeoutMs, activity.observeWorker
    )),
    async health() {
      const response = await fetchWithTimeout(`${baseUrl}${AGENTIC_HEALTH_PATH}`, {
        headers: authorizationHeaders(await authToken(input))
      }, Math.min(timeoutMs, 5_000));
      observeWorkerResponse(response, activity.observeWorker);
      if (!response.ok) throw new Error(`Agentic Worker health failed: HTTP ${response.status}`);
      const body = await response.json() as { ok?: unknown; role?: unknown };
      if (body.ok !== true || body.role !== "agentic") throw new Error("Agentic Worker returned an invalid health response");
      return { ok: true, role: "agentic" };
    },
    runProjectCycle: (body) => activity.run(() => post<AgenticProjectCycleResult>(
      baseUrl, AGENTIC_PROJECT_CYCLE_PATH, body, authToken(input), timeoutMs, activity.observeWorker
    ))
  };
}

async function post<T>(
  baseUrl: string,
  path: string,
  body: AgenticCommunicationDecisionRequest | AgenticProjectCycleRequest | Record<string, unknown>,
  authToken: string | Promise<string> | undefined,
  timeoutMs: number,
  observeWorker: (input: { pid: number; rss_bytes: number; started_at: string }) => void
): Promise<T> {
  const resolvedToken = isPromise(authToken) ? await authToken : authToken;
  const response = await fetchWithTimeout(`${baseUrl}${path}`, {
    body: JSON.stringify(body),
    headers: { ...authorizationHeaders(resolvedToken), "content-type": "application/json" },
    method: "POST"
  }, timeoutMs);
  observeWorkerResponse(response, observeWorker);
  const payload = await response.json().catch(() => null) as AgenticRpcResponse<T> | null;
  if (!response.ok || !payload || payload.ok !== true) {
    const detail = payload && "error" in payload ? payload.error : `HTTP ${response.status}`;
    throw new Error(`Agentic Worker request failed: ${detail}`);
  }
  return payload.result;
}

function isPromise(value: unknown): value is Promise<string> {
  return Boolean(value && typeof value === "object" && "then" in value);
}

function authToken(input: { authToken?: string; authTokenProvider?: () => string | Promise<string> }): string | Promise<string> | undefined {
  return input.authTokenProvider ? input.authTokenProvider() : input.authToken;
}

function observeWorkerResponse(
  response: Response,
  observe: (input: { pid: number; rss_bytes: number; started_at: string }) => void
): void {
  observe({
    pid: Number(response.headers.get("x-xuanwu-agentic-pid") ?? "0"),
    rss_bytes: Number(response.headers.get("x-xuanwu-agentic-rss-bytes") ?? "0"),
    started_at: response.headers.get("x-xuanwu-agentic-started-at") ?? ""
  });
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
