import type { RunnerDatabase } from "../db/database.ts";
import { enqueueIssue } from "../db/repositories/issueActions.ts";
import { createIssueComment } from "../db/repositories/issueEvents.ts";
import { createPendingPiAction, type PiActionRequest } from "./actionEngine.ts";
import type { PiActionMode, PiAuthorizationScope, PiGatePolicy } from "./actionGate.ts";
import { recordHeartbeatEvent, type heartbeatContext } from "./heartbeatOrchestratorSupport.ts";
import type { HeartbeatActionCandidate, HeartbeatActionSummary, HeartbeatInput, HeartbeatPolicy } from "./heartbeatTypes.ts";

type HeartbeatContext = ReturnType<typeof heartbeatContext>;

export function applyHeartbeatActionPlan(
  db: RunnerDatabase,
  ctx: HeartbeatContext,
  policy: HeartbeatPolicy,
  plan: HeartbeatActionCandidate[]
): HeartbeatActionSummary[] {
  return plan.map((candidate) => {
    recordHeartbeatEvent(db, ctx, "action_proposed", candidate);
    return createPendingPiAction(
      db,
      {
        authorization: policy.authorization,
        delegationID: ctx.delegationID,
        heartbeatID: ctx.heartbeatID,
        source: "pi_heartbeat"
      },
      actionRequest(candidate),
      policy.executor_busy ? undefined : executableAction(db, candidate)
    ) as HeartbeatActionSummary;
  });
}

export function heartbeatAuthorizationPolicy(input: HeartbeatInput, ctx: HeartbeatContext): PiGatePolicy {
  const delegation = input.delegation;
  const auth = objectValue(delegation?.authorization_json);
  return cleanPolicy({
    ...auth,
    allowed_actions: listValue(auth.allowed_actions ?? auth.allowedActions, delegation?.allowed_actions_json),
    forbidden_actions: listValue(auth.forbidden_actions ?? auth.forbiddenActions, delegation?.forbidden_actions_json),
    mode: workMode(auth.mode, delegation ? "delegated" : "attended"),
    now: ctx.nowText,
    scope: scopeValue(auth.scope ?? auth.scopes, delegation?.scope_json),
    starts_at: cleanString(auth.starts_at ?? auth.startsAt) || cleanString(delegation?.starts_at),
    expires_at: cleanString(auth.expires_at ?? auth.expiresAt) || cleanString(delegation?.expires_at)
  });
}

export function heartbeatAuthorizationSummary(policy: PiGatePolicy): Record<string, unknown> {
  return {
    allowed_actions: policy.allowed_actions ?? [],
    forbidden_actions: policy.forbidden_actions ?? [],
    mode: policy.mode ?? "attended",
    scope_present: policy.scope !== undefined || policy.scopes !== undefined,
    window: { expires_at: cleanString(policy.expires_at), starts_at: cleanString(policy.starts_at) }
  };
}

function actionRequest(candidate: HeartbeatActionCandidate): PiActionRequest {
  return {
    actionType: candidate.action_type,
    issueID: candidate.issue_id,
    payload: candidate.payload,
    projectID: candidate.project_id,
    rationale: candidate.rationale,
    riskOverride: {
      requiresConfirmation: candidate.requires_confirmation,
      riskLevel: candidate.risk_level
    }
  };
}

function executableAction(db: RunnerDatabase, candidate: HeartbeatActionCandidate): (() => unknown) | undefined {
  if (candidate.action_type === "issue.enqueue") return () => enqueueIssue(db, positiveIssueID(candidate));
  if (candidate.action_type === "needs_user.escalate") {
    return () => createIssueComment(db, positiveIssueID(candidate), {
      author: "agent",
      body: cleanString(candidate.payload.body) || candidate.rationale || "Heartbeat escalation"
    });
  }
  return undefined;
}

function positiveIssueID(candidate: HeartbeatActionCandidate): number {
  const id = candidate.issue_id ?? Number(candidate.payload.issue_id);
  if (Number.isSafeInteger(id) && id > 0) return id;
  throw new Error("heartbeat action issue_id is required");
}

function cleanPolicy(policy: PiGatePolicy): PiGatePolicy {
  return Object.fromEntries(Object.entries(policy).filter(([, value]) => (
    Array.isArray(value) ? value.length > 0 : value !== undefined && value !== ""
  ))) as PiGatePolicy;
}

function listValue(primary: unknown, fallback: unknown): string[] {
  const list = stringList(primary);
  return list.length > 0 ? list : stringList(fallback);
}

function scopeValue(primary: unknown, fallback: unknown): PiAuthorizationScope | PiAuthorizationScope[] | undefined {
  const value = structuredValue(primary);
  return (value === undefined ? structuredValue(fallback) : value) as PiAuthorizationScope | PiAuthorizationScope[] | undefined;
}

function workMode(value: unknown, fallback: PiActionMode): PiActionMode {
  const mode = cleanString(value);
  if (mode === "manual" || mode === "attended" || mode === "delegated" || mode === "autonomous") return mode;
  return fallback;
}

function structuredValue(value: unknown): unknown {
  if (value && typeof value === "object") return value;
  const text = cleanString(value);
  if (text === "") return undefined;
  try { return JSON.parse(text) as unknown; } catch { return undefined; }
}

function objectValue(value: unknown): Record<string, unknown> {
  const parsed = structuredValue(value);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
}

function stringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(cleanString).filter(Boolean);
  const text = cleanString(value);
  if (text === "") return [];
  try {
    const parsed = JSON.parse(text) as unknown;
    if (Array.isArray(parsed)) return parsed.map(cleanString).filter(Boolean);
  } catch {}
  return text.split(/\n|,/).map(cleanString).filter(Boolean);
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
