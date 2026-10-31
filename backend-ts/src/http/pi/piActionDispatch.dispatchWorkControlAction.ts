import { getAgentSession } from "../../db/repositories/agentSessions.ts";
import { assertWorkspaceWaitSessionControl } from "../../db/repositories/workspaceWaits.ts";
import { getIssue, listIssueRuns } from "../../db/repositories/issues.ts";
import { appendRunMemoryPrompt } from "../../pi/memory/runMemoryContext.ts";
import type { PiAction } from "../../db/repositories/pi.ts";
import type { ToolPermission } from "../../pi/tools/toolProviderEnvelope.ts";
import { registerRunRoutes } from "../work/runApi.ts";
import { registerWorkRoutes } from "../work/workApi.ts";
import { createRouter } from "../router.ts";
import { cleanString } from "../../util/values.ts";
import { providersForProjectID } from "../../nodes/remoteExecution.ts";
import type { PiActionDispatchContext } from "./piActionDispatch.model.ts";
import { requiredPayloadText } from "./piActionDispatch.replyDraftPayload.ts";
import { sessionProviderID, sessionProviderSessionID, latestSessionTurnID, persistSteeredSession } from "./piActionDispatch.requestIssueAcceptanceAction.ts";

export async function dispatchWorkControlAction(
  context: PiActionDispatchContext,
  action: PiAction,
  payload: Record<string, unknown>
): Promise<unknown> {
  const operation = action.action_type.slice("work.".length);
  const router = createRouter();
  registerWorkRoutes(router, { database: context.database, providers: context.providers });
  const audit = controlAudit(action, payload);
  let path = "/api/works";
  let method: "PATCH" | "POST" = "POST";
  let body: Record<string, unknown>;
  if (operation === "create") {
    body = {
      audit,
      ...(Array.isArray(payload.depends_on_issue_ids) ? { depends_on_issue_ids: payload.depends_on_issue_ids } : {}),
      goal: payload.goal,
      project_id: payload.project_id || action.project_id,
      status: payload.status || "triage",
      title: payload.title,
      type: "engineering_task"
    };
  } else {
    const workID = requiredPayloadText(payload, "work_id");
    path = `/api/works/${encodeURIComponent(workID)}`;
    if (operation === "update") {
      method = "PATCH";
      body = {
        audit,
        expected_revision: payload.expected_revision,
        ...(payload.goal === undefined ? {} : { goal: payload.goal }),
        ...(payload.title === undefined ? {} : { title: payload.title })
      };
    } else {
      path += `/actions/${operation}`;
      body = { audit, expected_revision: payload.expected_revision };
    }
  }
  return await callControlRoute(router, path, method, body, "Work control");
}

export async function dispatchRunControlAction(
  context: PiActionDispatchContext,
  action: PiAction,
  payload: Record<string, unknown>
): Promise<unknown> {
  const runID = requiredPayloadText(payload, "run_id");
  const operation = action.action_type.slice("run.".length);
  const router = createRouter();
  registerRunRoutes(router, { database: context.database, providers: context.providers });
  return await callControlRoute(
    router,
    `/api/runs/${encodeURIComponent(runID)}/actions/${operation}`,
    "POST",
    {
      audit: controlAudit(action, payload),
      ...(payload.expected_attempt_revision === undefined
        ? {}
        : { expected_attempt_revision: payload.expected_attempt_revision }),
      expected_revision: payload.expected_revision,
      ...(cleanString(payload.prompt) === "" ? {} : { prompt: cleanString(payload.prompt) })
    },
    "Run control"
  );
}

export function controlAudit(action: PiAction, payload: Record<string, unknown>): Record<string, unknown> {
  return {
    actor: { id: action.approved_by || action.decided_by || "user", kind: "user" },
    correlation_id: action.conversation_id || action.id,
    event_id: `pi-action-control:${action.id}`,
    occurred_at: new Date().toISOString(),
    reason: cleanString(payload.reason) || action.rationale || `approved ${action.action_type}`
  };
}

export async function callControlRoute(
  router: ReturnType<typeof createRouter>,
  path: string,
  method: "PATCH" | "POST",
  body: Record<string, unknown>,
  label: string
): Promise<unknown> {
  const response = await router.handle(new Request(`http://pi-action.internal${path}`, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method
  }));
  const result = await response.json().catch(() => ({ message: `${label} returned non-JSON` }));
  if (!response.ok) {
    const message = result && typeof result === "object" && !Array.isArray(result)
      ? cleanString((result as Record<string, unknown>).message)
      : "";
    throw new Error(message || `${label} failed with HTTP ${response.status}`);
  }
  return result;
}

export function toolPermission(value: unknown): ToolPermission {
  const permission = cleanString(value);
  if (permission === "read" || permission === "write" || permission === "dangerous") return permission;
  return "dangerous";
}

export function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(cleanString).filter(Boolean) : [];
}

export async function steerSession(
  context: PiActionDispatchContext,
  payload: Record<string, unknown>
): Promise<unknown> {
  const providerID = sessionProviderID(payload);
  const sessionID = sessionProviderSessionID(payload);
  const prompt = cleanString(payload.prompt);
  if (prompt === "") throw new Error("prompt is required");
  const session = getAgentSession(context.database, `${providerID}:${sessionID}`);
  const sessionIssue = session?.issue_id ? getIssue(context.database, session.issue_id) : null;
  const provider = providersForProjectID(context.database, context.providers, sessionIssue?.project_id ?? "")?.[providerID];
  if (!provider?.sendSessionMessage) throw new Error(`provider "${providerID}" 不支持 capability "resume_session"`);
  assertWorkspaceWaitSessionControl(context.database, providerID, sessionID);
  const run = session?.issue_id ? listIssueRuns(context.database, session.issue_id).at(-1) : undefined;
  const memoryPrompt = run?.ended_at === "" && run.provider === providerID && run.provider_session_id === sessionID
    ? appendRunMemoryPrompt(context.database, session!.issue_id, run.id, prompt, "recovery") : prompt;
  const result = await provider.sendSessionMessage({
    mode: "steer",
    prompt: memoryPrompt,
    sessionId: sessionID,
    turnId: latestSessionTurnID(context.database, providerID, sessionID, payload)
  });
  persistSteeredSession(context.database, providerID, sessionID, result.turn_id);
  return result;
}
