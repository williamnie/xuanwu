import type { AfterToolCallContext, AfterToolCallResult, BeforeToolCallContext } from "@earendil-works/pi-agent-core";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { RunnerDatabase } from "../db/database.ts";
import { createPiAction, updatePiAction, type PiAction } from "../db/repositories/pi.ts";
import type { EventBus } from "../events/bus.ts";
import { gatePiActionEnvelope, type PiGatePolicy } from "../pi/actionGate.ts";
import { normalizePiActionEnvelope } from "../pi/actionEnvelope.ts";
import { publishPiActionEvent, recordPiActionAuditEvent } from "../pi/actionEngine.ts";
import { recordToolCallAuditEvent } from "../pi/toolCallAudit.ts";
import type { PiRuntimeToolAuditTarget } from "../pi/piRuntimeTools.ts";

type SdkAuditContext = {
  authorization?: PiGatePolicy;
  bus?: EventBus;
  conversationID: string;
  delegationID?: string;
  heartbeatID?: string;
  issueID?: number;
  projectID?: string;
  readOnlyToolNames?: string[];
  source?: string;
  toolAuditTargets?: Record<string, PiRuntimeToolAuditTarget>;
};

const READ_ONLY_TOOL_NAMES = new Set(["read", "grep", "find", "ls"]);
const SOURCE = "pi_sdk_tool";
type ActiveToolAudit = { args: unknown; startedAt: number; toolName: string };

export function installPiSdkToolAudit(
  db: RunnerDatabase,
  session: AgentSession,
  context: SdkAuditContext
): () => void {
  const active = new Map<string, PiAction>();
  const toolAudits = new Map<string, ActiveToolAudit>();
  const previousBefore = session.agent.beforeToolCall;
  const previousAfter = session.agent.afterToolCall;
  const beforeHook = async (hook: BeforeToolCallContext, signal?: AbortSignal) => {
    startToolAudit(toolAudits, hook);
    const started = startSdkAction(db, context, hook);
    if (started && started.gate_decision !== "execute") {
      finishToolAudit(db, context, toolAudits, hook.toolCall.id, {
        error: { message: started.gate_reason || "Tool execution denied", type: "permission_denied" },
        status: "denied"
      });
      return { block: true, reason: started.gate_reason };
    }
    if (started) active.set(hook.toolCall.id, started);
    try {
      const result = await previousBefore?.(hook, signal);
      if (result?.block && started) finishSdkAction(db, context, active, hook.toolCall.id, {
        error: result.reason || "Tool execution was blocked",
        isError: true
      });
      if (result?.block) finishToolAudit(db, context, toolAudits, hook.toolCall.id, {
        error: { message: result.reason || "Tool execution was blocked", type: "permission_denied" },
        status: "denied"
      });
      return result;
    } catch (error) {
      if (started) finishSdkAction(db, context, active, hook.toolCall.id, { error: errorMessage(error), isError: true });
      finishToolAudit(db, context, toolAudits, hook.toolCall.id, {
        error: { message: errorMessage(error), type: errorType(error) },
        status: "failed"
      });
      throw error;
    }
  };
  const afterHook = async (hook: AfterToolCallContext, signal?: AbortSignal) => {
    try {
      const result = await previousAfter?.(hook, signal);
      finishSdkAction(db, context, active, hook.toolCall.id, afterResult(hook, result));
      finishToolAudit(db, context, toolAudits, hook.toolCall.id, afterAuditResult(hook, result));
      return result;
    } catch (error) {
      finishSdkAction(db, context, active, hook.toolCall.id, { error: errorMessage(error), isError: true });
      finishToolAudit(db, context, toolAudits, hook.toolCall.id, {
        error: { message: errorMessage(error), type: errorType(error) },
        status: "failed"
      });
      throw error;
    }
  };
  session.agent.beforeToolCall = beforeHook;
  session.agent.afterToolCall = afterHook;

  return () => {
    if (session.agent.beforeToolCall === beforeHook) session.agent.beforeToolCall = previousBefore;
    if (session.agent.afterToolCall === afterHook) session.agent.afterToolCall = previousAfter;
  };
}

function startToolAudit(active: Map<string, ActiveToolAudit>, hook: BeforeToolCallContext): ActiveToolAudit {
  const audit = { args: hook.args, startedAt: Date.now(), toolName: cleanString(hook.toolCall.name) };
  active.set(hook.toolCall.id, audit);
  return audit;
}

function finishToolAudit(
  db: RunnerDatabase,
  context: SdkAuditContext,
  active: Map<string, ActiveToolAudit>,
  toolCallID: string,
  outcome: { error?: { message: string; type: string }; output?: unknown; status: "denied" | "failed" | "succeeded" }
): void {
  const audit = active.get(toolCallID);
  if (!audit) return;
  active.delete(toolCallID);
  const target = context.toolAuditTargets?.[audit.toolName];
  try {
    recordToolCallAuditEvent(db, context, {
      args: audit.args,
      durationMs: Date.now() - audit.startedAt,
      error: outcome.error,
      output: outcome.output,
      permission: target?.permission === "unknown" ? undefined : target?.permission,
      providerID: target?.providerID,
      status: outcome.status,
      toolCallID,
      toolName: audit.toolName
    });
  } catch (error) {
    console.warn("[pi-runtime] failed to audit tool call:", errorMessage(error));
  }
}

function startSdkAction(
  db: RunnerDatabase,
  context: SdkAuditContext,
  hook: BeforeToolCallContext
): PiAction | null {
  const toolName = cleanString(hook.toolCall.name);
  if (!READ_ONLY_TOOL_NAMES.has(toolName)) return null;
  const actionType = `sdk.${toolName}`;
  const payload = sdkPayload(hook.toolCall.id, toolName, hook.args);
  const envelope = normalizePiActionEnvelope({
    action_type: actionType,
    delegation_id: cleanString(context.delegationID),
    heartbeat_id: cleanString(context.heartbeatID),
    payload,
    project_id: cleanString(context.projectID),
    rationale: "SDK read-only tool call",
    source: SOURCE
  });
  const candidate = createPiAction(db, {
    id: crypto.randomUUID(),
    action_type: actionType,
    conversation_id: cleanString(context.conversationID),
    delegation_id: envelope.delegation_id,
    heartbeat_id: envelope.heartbeat_id,
    payload_json: JSON.stringify(payload),
    project_id: envelope.project_id,
    rationale: envelope.rationale,
    requires_confirmation: envelope.requires_confirmation ? 1 : 0,
    risk_level: envelope.risk_level,
    source: SOURCE,
    status: "candidate"
  });
  recordPiActionAuditEvent(db, candidate, "candidate", { actor: "pi", payload: envelope });
  const decision = gatePiActionEnvelope(envelope, context.authorization);
  const gated = updatePiAction(db, candidate.id, {
    gate_decision: decision.decision,
    gate_reason: decision.reason,
    status: gateStatus(decision.decision)
  });
  recordPiActionAuditEvent(db, gated, "gate_decision", {
    actor: "gate",
    decision: decision.decision,
    reason: decision.reason
  });
  if (decision.decision !== "execute") {
    publishGateEvent(context.bus, decision.decision, gated);
    return gated;
  }
  const executing = updatePiAction(db, gated.id, { status: "executing" });
  recordPiActionAuditEvent(db, executing, "execution_started", { actor: "gate", decision: "execute" });
  publishPiActionEvent(context.bus, "pi.action_executing", executing);
  return executing;
}

function finishSdkAction(
  db: RunnerDatabase,
  context: SdkAuditContext,
  active: Map<string, PiAction>,
  toolCallID: string,
  outcome: { error?: string; isError: boolean; result?: unknown }
): void {
  const action = active.get(toolCallID);
  if (!action) return;
  active.delete(toolCallID);
  if (outcome.isError) {
    const failed = updatePiAction(db, action.id, {
      result_json: JSON.stringify({ error: cleanString(outcome.error) || "SDK tool execution failed" }),
      status: "failed"
    });
    recordPiActionAuditEvent(db, failed, "execution_error", { actor: "executor", error: outcome.error });
    publishPiActionEvent(context.bus, "pi.action_failed", failed);
    return;
  }
  const completed = updatePiAction(db, action.id, {
    result_json: JSON.stringify(sdkResult(outcome.result, false)),
    status: "completed"
  });
  recordPiActionAuditEvent(db, completed, "execution_result", { actor: "executor", result: sdkResult(outcome.result, false) });
  publishPiActionEvent(context.bus, "pi.action_completed", completed);
}

function afterResult(hook: AfterToolCallContext, result: AfterToolCallResult | undefined) {
  return {
    isError: result?.isError ?? hook.isError,
    result: sdkResult(result?.content ?? hook.result.content, result?.isError ?? hook.isError)
  };
}

function afterAuditResult(hook: AfterToolCallContext, result: AfterToolCallResult | undefined) {
  const isError = result?.isError ?? hook.isError;
  return {
    error: isError ? { message: errorSummary(result?.content ?? hook.result.content), type: "tool_error" } : undefined,
    output: result?.details ?? result?.content ?? hook.result.details ?? hook.result.content,
    status: isError ? "failed" as const : "succeeded" as const
  };
}

function sdkPayload(toolCallID: string, toolName: string, args: unknown): Record<string, unknown> {
  return {
    args: sanitizeJson(args),
    tool_call_id: cleanString(toolCallID),
    tool_name: toolName
  };
}

function sdkResult(result: unknown, isError: boolean): Record<string, unknown> {
  return { is_error: isError, summary: summarizeResult(result) };
}

function summarizeResult(result: unknown): Record<string, unknown> {
  if (Array.isArray(result)) return { content_blocks: result.length };
  if (typeof result === "object" && result !== null) return { keys: Object.keys(result).slice(0, 8) };
  return { type: typeof result };
}

function sanitizeJson(value: unknown): unknown {
  if (value === null || ["boolean", "number", "string"].includes(typeof value)) return value;
  if (Array.isArray(value)) return value.map(sanitizeJson);
  if (typeof value !== "object") return String(value);
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, sanitizeJson(entry)]));
}

function gateStatus(decision: string): string {
  if (decision === "execute") return "approved";
  if (decision === "ask") return "pending";
  if (decision === "snooze") return "snoozed";
  return "denied";
}

function publishGateEvent(bus: EventBus | undefined, decision: string, action: PiAction): void {
  if (decision === "deny") publishPiActionEvent(bus, "pi.action_denied", action);
  if (decision === "snooze") publishPiActionEvent(bus, "pi.action_snoozed", action);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "SDK tool execution failed";
}

function errorSummary(value: unknown): string {
  const text = collectText(value).trim();
  return text === "" ? "Tool execution failed" : text;
}

function collectText(value: unknown): string {
  if (!Array.isArray(value)) return typeof value === "string" ? value : "";
  return value.map((block) => {
    if (typeof block === "object" && block && "text" in block && typeof block.text === "string") return block.text;
    return "";
  }).filter(Boolean).join("\n");
}

function errorType(error: unknown): string {
  return error instanceof Error && error.name !== "" ? error.name : "tool_error";
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
