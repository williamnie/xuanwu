import { type ApprovalDecision, type ProviderEvent, type ProviderRunInput } from "../types.ts";
import { isAbsolute, relative, resolve } from "node:path";
import { PiRpcTransport, type PiRpcEvent } from "./rpcTransport.ts";
import { normalizedRunEvent } from "../runEvents.ts";
import { objectValue } from "../../util/values.ts";
import { stringValue } from "./providerSettings.ts";

export type PiPolicyToolCall = { toolCallId: string; toolName: string; input: Record<string, unknown> };

export type PiPendingApproval = {
  call: PiPolicyToolCall;
  cleanup: () => void;
  id: string;
  invocationRef: string;
  rawId: string;
  sessionRef: string;
  sink: ProviderRunInput["onEvent"];
  transport: PiRpcTransport;
};

export function parsePolicyToolCall(value: unknown): PiPolicyToolCall | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (parsed.contract !== "xw.pi-policy-tool-call.v1") return undefined;
    const toolName = stringValue(parsed.toolName).toLowerCase();
    if (toolName === "") return undefined;
    return {
      toolCallId: stringValue(parsed.toolCallId),
      toolName,
      input: objectValue(parsed.input)
    };
  } catch {
    return undefined;
  }
}

export function piPolicyDecision(
  policy: ProviderRunInput["policy"],
  call: PiPolicyToolCall,
  cwd: string
): "allow" | "ask" | "deny" {
  if (!policy || policy.requested.access === "read-only") return "deny";
  if (policy.requested.access === "provider-native-development" && toolWritesOutsideProject(call, cwd)) return "deny";
  if (policy.requested.approval === "unattended") return "allow";
  if (policy.requested.approval === "ask-every-side-effect") return "ask";
  return piToolSensitivity(call, cwd) === "routine" ? "allow" : "ask";
}

export function piToolSensitivity(call: PiPolicyToolCall, cwd: string): "routine" | "sensitive" {
  if (["edit", "write"].includes(call.toolName)) {
    return toolWritesOutsideProject(call, cwd) ? "sensitive" : "routine";
  }
  if (call.toolName !== "bash") return "sensitive";
  const command = stringValue(call.input.command ?? call.input.cmd).trim();
  if (/^(?:git\s+(?:status|diff|show|log)(?:\s|$)|(?:bun|npm|pnpm|yarn)\s+(?:test|run\s+(?:test|lint|build|format|check))(?:\s|$)|(?:cargo|go)\s+(?:test|check|build)(?:\s|$)|(?:pytest|python\s+-m\s+pytest|swift\s+test|xcodebuild\b))/.test(command)) {
    return "routine";
  }
  return "sensitive";
}

export function toolWritesOutsideProject(call: PiPolicyToolCall, cwdValue: string): boolean {
  if (!["edit", "write"].includes(call.toolName)) return false;
  const cwd = cwdValue.trim();
  const path = stringValue(call.input.path ?? call.input.file_path);
  if (!isAbsolute(cwd) || path === "") return true;
  const target = isAbsolute(path) ? resolve(path) : resolve(cwd, path);
  const scoped = relative(resolve(cwd), target);
  return scoped.startsWith("..") || isAbsolute(scoped);
}

export function piApprovalEvent(
  pending: PiPendingApproval,
  method: "approval/requested" | "approval/resolved",
  status: string
): ProviderEvent {
  const session = pending.sessionRef ? { provider: "pi-coding-agent" as const, sessionId: pending.sessionRef } : undefined;
  const payload = {
    id: pending.id,
    method: "pi/extension-ui-confirm",
    params: {
      callback_owner_ref: pending.invocationRef,
      invocation_ref: pending.invocationRef,
      policy_revision: "xw.resolved-execution-policy.v1",
      tool_name: pending.call.toolName,
      tool_use_id: pending.call.toolCallId,
      tool_input_summary: piApprovalInputSummary(pending.call)
    }
  };
  const resolved = method === "approval/resolved";
  return {
    payload,
    provider: "pi-coding-agent",
    raw: { method, payload },
    runEvent: normalizedRunEvent({
      kind: resolved ? "approval_resolved" : "approval_requested",
      method,
      outcome: resolved ? "running" : "waiting_approval",
      provider: "pi-coding-agent",
      session
    }),
    session,
    status,
    type: "approval"
  };
}

export function piApprovalInputSummary(call: PiPolicyToolCall): string {
  const command = stringValue(call.input.command ?? call.input.cmd);
  const path = stringValue(call.input.path ?? call.input.file_path);
  const value = JSON.stringify({
    tool: call.toolName,
    ...(command ? { command: command.slice(0, 160) } : {}),
    ...(path ? { path: isAbsolute(path) ? "<absolute-path>" : path.slice(0, 160) } : {})
  });
  return value.slice(0, 320);
}

export class PiPolicyApprovals {
  private readonly pendingApprovals = new Map<string, PiPendingApproval>();
async resolveApproval(requestId: string, decision: ApprovalDecision): Promise<void> {
    const pending = this.pendingApprovals.get(requestId.trim());
    if (!pending) throw new Error(`Pi approval request is not pending: ${requestId.trim()}`);
    const approved = ["approve", "allow"].includes(String(decision.decision ?? "").trim().toLowerCase());
    await this.finishApproval(pending, approved, approved ? "approve" : "deny");
  }

async handlePolicyApprovalRequest(
    event: PiRpcEvent,
    transport: PiRpcTransport,
    sink: ProviderRunInput["onEvent"],
    input: Pick<ProviderRunInput, "cwd" | "policy">,
    sessionRef: string,
    invocationRef: string
  ): Promise<void> {
    if (stringValue(event.method) !== "confirm" || stringValue(event.title) !== "Xuanwu execution policy") return;
    const rawId = stringValue(event.id);
    const call = parsePolicyToolCall(event.message);
    if (rawId === "" || !call) {
      if (rawId) await transport.respondExtensionUI(rawId, { confirmed: false });
      return;
    }
    const id = `${invocationRef}:${rawId}`;
    const decision = piPolicyDecision(input.policy, call, input.cwd ?? "");
    if (decision !== "ask") {
      await transport.respondExtensionUI(rawId, { confirmed: decision === "allow" });
      return;
    }
    if (this.pendingApprovals.has(id)) {
      await transport.respondExtensionUI(rawId, { confirmed: false });
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const pending: PiPendingApproval = {
      call,
      id,
      invocationRef,
      rawId,
      sessionRef,
      sink,
      transport,
      cleanup: () => { if (timer) clearTimeout(timer); }
    };
    this.pendingApprovals.set(id, pending);
    timer = setTimeout(() => {
      if (this.pendingApprovals.get(id) === pending) void this.finishApproval(pending, false, "timeout");
    }, 4 * 60_000 + 50_000);
    timer.unref?.();
    sink?.(piApprovalEvent(pending, "approval/requested", "pending"));
  }

private async finishApproval(pending: PiPendingApproval, approved: boolean, decision: string): Promise<void> {
    if (this.pendingApprovals.get(pending.id) !== pending) return;
    this.pendingApprovals.delete(pending.id);
    pending.cleanup();
    try {
      await pending.transport.respondExtensionUI(pending.rawId, { confirmed: approved });
    } finally {
      pending.sink?.(piApprovalEvent(pending, "approval/resolved", decision));
    }
  }

async rejectPendingApprovals(reason: string): Promise<void> {
    for (const pending of [...this.pendingApprovals.values()]) {
      await this.finishApproval(pending, false, reason).catch(() => undefined);
    }
  }
}
