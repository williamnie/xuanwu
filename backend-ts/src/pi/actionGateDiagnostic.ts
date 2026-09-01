import type { RunnerDatabase } from "../db/database.ts";
import type { PiAction } from "../db/repositories/pi.ts";
import { evaluatePiActionFreshness } from "./actionFreshness.ts";

export type PiGateLayer =
  | "action_gate"
  | "completion_gate"
  | "mcp_policy"
  | "provider_execution_policy"
  | "source_policy";

export type PiActionGateDiagnostic = {
  authorization_source: string;
  blocked_layer: PiGateLayer;
  can_approve: boolean;
  decision: string;
  expires_at: string;
  freshness: "current" | "expired" | "stale" | "terminal";
  reason: string;
  reason_code: string;
  scope: Record<string, unknown>;
  user_action: string;
};

export function piActionGateDiagnostic(
  db: RunnerDatabase,
  action: PiAction,
  now = new Date()
): PiActionGateDiagnostic {
  const payload = parseObject(action.payload_json);
  const freshness = actionFreshness(db, action, now);
  const reason = action.gate_reason || resultReason(action.result_json) || action.status;
  const decision = action.gate_decision || action.status;
  const canApprove = freshness === "current" && action.status === "pending" && decision === "ask";
  return {
    authorization_source: authorizationSource(action),
    blocked_layer: blockedLayer(action, reason),
    can_approve: canApprove,
    decision,
    expires_at: action.lease_expires_at,
    freshness,
    reason,
    reason_code: reasonCode(action, reason, freshness),
    scope: actionScope(action, payload),
    user_action: userAction(action, freshness, canApprove)
  };
}

function actionFreshness(
  db: RunnerDatabase,
  action: PiAction,
  now: Date
): PiActionGateDiagnostic["freshness"] {
  if (["completed", "failed", "rejected"].includes(action.status)) return "terminal";
  const expiry = Date.parse(action.lease_expires_at);
  if (Number.isFinite(expiry) && expiry <= now.getTime()) return "expired";
  return evaluatePiActionFreshness(db, action).fresh ? "current" : "stale";
}

function blockedLayer(action: PiAction, reason: string): PiGateLayer {
  if (action.action_type === "mcp.tool.call" || /MCP capability|MCP server/i.test(reason)) return "mcp_policy";
  if (action.source === "action_proposal" && /source|reply|auto_/i.test(reason)) return "source_policy";
  return "action_gate";
}

function reasonCode(
  action: PiAction,
  reason: string,
  freshness: PiActionGateDiagnostic["freshness"]
): string {
  const text = `${reason} ${resultReason(action.result_json)}`;
  if (freshness === "expired" || /approval_expired|approval_ttl_expired/i.test(text)) return "approval_expired";
  if (freshness === "stale" || /stale|superseded_by|target_.*changed|already_terminal/i.test(text)) return "stale_target_state";
  if (/high-risk action requires user confirmation/i.test(text)) return "high_risk_confirmation_required";
  if (/requires explicit user approval for this target/i.test(text)) return "explicit_target_approval_required";
  if (/manual mode requires user approval|risk requires user confirmation/i.test(text)) return "risk_confirmation_required";
  if (/scope .*does not match|outside the authorized action envelope/i.test(text)) return "scope_mismatch";
  if (/allowed_actions/i.test(text)) return "action_not_allowlisted";
  if (/authorization envelope/i.test(text)) return "target_not_authorized";
  if (/MCP capability/i.test(text)) return "mcp_capability_not_authorized";
  if (action.status === "rejected" || action.gate_decision === "deny") return "action_denied";
  return "action_approval_required";
}

function actionScope(action: PiAction, payload: Record<string, unknown>): Record<string, unknown> {
  const issueIDs = uniquePositiveIDs([
    action.issue_id,
    ...numberList(payload.issue_id),
    ...numberList(payload.issue_ids)
  ]);
  return compact({
    capability_id: cleanString(payload.capability_id),
    issue_ids: issueIDs.length > 0 ? issueIDs : undefined,
    project_id: action.project_id || cleanString(payload.project_id),
    run_id: cleanString(payload.run_id),
    session_key: cleanString(payload.session_key) || sessionRef(payload),
    work_id: cleanString(payload.work_id)
  });
}

function authorizationSource(action: PiAction): string {
  if (action.approved_by !== "") return "human_approval";
  if (action.source === "runner_chat" || action.source.endsWith("_runner_chat")) return "current_runner_chat_turn";
  if (action.source.includes("supervisor") || action.guardian_decision_id !== "") return "supervisor_policy";
  if (action.source === "action_proposal") return "source_policy";
  return action.source || "deterministic_policy";
}

function userAction(
  action: PiAction,
  freshness: PiActionGateDiagnostic["freshness"],
  canApprove: boolean
): string {
  if (freshness === "expired") return "审批已过期；刷新目标状态后重新发起动作。";
  if (freshness === "stale") return "目标状态已经变化；拒绝旧请求并基于最新状态重新发起。";
  if (freshness === "terminal") return "该请求已经结束，无需再次批准。";
  if (canApprove) return "核对目标、范围和风险后，批准一次或拒绝。";
  if (action.gate_decision === "deny") return "当前请求不可批准；调整权限或目标后重新发起。";
  return "刷新当前状态并查看审计记录。";
}

function resultReason(value: string): string {
  return cleanString(parseObject(value).reason);
}

function sessionRef(payload: Record<string, unknown>): string {
  const provider = cleanString(payload.provider);
  const session = cleanString(payload.provider_session_id);
  return provider && session ? `${provider}:${session}` : session;
}

function parseObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value || "{}") as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function numberList(value: unknown): number[] {
  if (Array.isArray(value)) return value.flatMap(numberList);
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? [value] : [];
}

function uniquePositiveIDs(values: number[]): number[] {
  return [...new Set(values.filter((value) => value > 0))];
}

function compact(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => (
    item !== undefined && item !== "" && (!Array.isArray(item) || item.length > 0)
  )));
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
