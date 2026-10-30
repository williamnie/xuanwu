import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { PermissionResult } from "@qoder-ai/qoder-agent-sdk";
import { redactionRegistry } from "../../security/redactionRegistry.ts";
import { redactSensitiveText } from "../../util/redact.ts";
import { normalizedRunEvent } from "../runEvents.ts";
import type { ApprovalDecision, ProviderEvent } from "../types.ts";
import { cleanString } from "../../util/values.ts";
import { PendingPermission, WRITE_TOOLS, QoderApprovalPolicy, QoderSandbox } from "./permissionModel.ts";

export function permissionEvent(
  pending: PendingPermission,
  method: "approval/requested" | "approval/resolved",
  status: string,
  resolution?: { decision: string; reason: string; scope: string }
): ProviderEvent {
  const session = pending.context.session();
  const payload = redactionRegistry.redactValue({
    id: pending.id,
    method: "qoder/canUseTool",
    params: {
      callback_owner_ref: pending.context.invocationRef,
      agent_id: cleanString(pending.options.agentID),
      blocked_path: redactedPath(pending.options.blockedPath, pending.context.cwd),
      decision_reason: redactSensitiveText(cleanString(pending.options.decisionReason)),
      description: redactSensitiveText(cleanString(pending.options.description)),
      display_name: redactSensitiveText(cleanString(pending.options.displayName)),
      path: WRITE_TOOLS.has(pending.toolName) ? pending.path : "",
      invocation_ref: pending.context.invocationRef,
      policy_revision: pending.context.policy?.contract ?? "legacy",
      threadId: session?.sessionId ?? "",
      tool_input_summary: pending.inputSummary,
      tool_name: pending.toolName,
      tool_use_id: pending.options.toolUseID,
      turnId: session?.turnId ?? ""
    },
    ...(resolution ? { decision: resolution.decision, reason: redactSensitiveText(resolution.reason), scope: resolution.scope } : {})
  }) as Record<string, unknown>;
  const resolved = method === "approval/resolved";
  return {
    payload,
    provider: "qoder",
    raw: { method, payload },
    runEvent: normalizedRunEvent({
      kind: resolved ? "approval_resolved" : "approval_requested",
      method,
      outcome: resolved ? "running" : "waiting_approval",
      provider: "qoder",
      session
    }),
    session,
    status,
    type: "approval"
  };
}

export function normalizePolicy(value: string | undefined): QoderApprovalPolicy {
  const policy = cleanString(value) || "never";
  if (policy === "never" || policy === "danger-only" || policy === "always") return policy;
  throw new Error(`Unsupported Qoder approval policy ${policy}`);
}

export function normalizeSandbox(value: string | undefined): QoderSandbox {
  const sandbox = cleanString(value) || "workspace-write";
  if (sandbox === "danger-full-access" || sandbox === "read-only" || sandbox === "workspace-write") return sandbox;
  throw new Error(`Unsupported Qoder sandbox ${sandbox}`);
}

export async function inputPathWithinWorkspace(input: Record<string, unknown>, cwdValue: string): Promise<boolean> {
  const cwd = cleanString(cwdValue);
  const path = firstText(input.file_path, input.path, input.notebook_path);
  if (!isAbsolute(cwd) || path === "") return false;
  try {
    const workspace = await realpath(cwd);
    let probe = resolve(cwd, path);
    while (true) {
      try {
        const resolvedProbe = await realpath(probe);
        const scoped = relative(workspace, resolvedProbe);
        return scoped === "" || (!scoped.startsWith("..") && !isAbsolute(scoped));
      } catch (error) {
        if (!missingPath(error)) return false;
        const parent = dirname(probe);
        if (parent === probe) return false;
        probe = parent;
      }
    }
  } catch {
    return false;
  }
}

export function toolInputSummary(input: Record<string, unknown>, cwd: string): string {
  const safe = redactionRegistry.redactValue({
    command: cleanString(input.command ?? input.cmd),
    path: redactedPath(firstText(input.file_path, input.path, input.notebook_path), cwd),
    description: redactSensitiveText(cleanString(input.description))
  });
  const text = JSON.stringify(safe);
  return text.length > 320 ? `${text.slice(0, 319)}…` : text;
}

export function redactedPath(value: unknown, cwdValue: string): string {
  const path = cleanString(value);
  const cwd = cleanString(cwdValue);
  if (!path) return "";
  const absolute = isAbsolute(path) ? resolve(path) : isAbsolute(cwd) ? resolve(cwd, path) : "";
  if (absolute && isAbsolute(cwd)) {
    const scoped = relative(resolve(cwd), absolute);
    if (scoped === "") return "<workspace>";
    if (!scoped.startsWith("..") && !isAbsolute(scoped)) return `<workspace>/${scoped}`;
  }
  return "<redacted-path>";
}

export function allowResult(toolUseID: string): PermissionResult {
  return { behavior: "allow", decisionClassification: "user_temporary", toolUseID };
}

export function denyResult(toolUseID: string, message: string, interrupt = false): PermissionResult {
  return {
    behavior: "deny",
    decisionClassification: "user_reject",
    ...(interrupt ? { interrupt: true } : {}),
    message: redactSensitiveText(message),
    toolUseID
  };
}

export function cancelledDecision(decision: ApprovalDecision): boolean {
  return ["abort", "cancel"].includes(cleanString(decision.decision));
}

export function firstText(...values: unknown[]): string {
  return values.map(cleanString).find(Boolean) ?? "";
}

export function missingPath(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}
