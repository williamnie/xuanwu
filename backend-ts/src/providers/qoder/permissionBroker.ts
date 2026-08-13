import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { CanUseTool, CanUseToolOptions, Options, PermissionResult } from "@qoder-ai/qoder-agent-sdk";
import { redactionRegistry } from "../../security/redactionRegistry.ts";
import { redactSensitiveText } from "../../util/redact.ts";
import { constrainApprovalGrantScope } from "../../pi/approvalGrantScope.ts";
import { normalizedRunEvent } from "../runEvents.ts";
import type { ApprovalDecision, ProviderEvent, SessionRef } from "../types.ts";

const READ_TOOLS = ["Read", "Grep", "Glob"] as const;
const WRITE_TOOLS = new Set(["Edit", "Write"]);
const BLOCKED_TOOLS = ["Agent", "Bash", "NotebookEdit"] as const;

export type QoderApprovalPolicy = "never" | "danger-only" | "always";
export type QoderSandbox = "read-only" | "workspace-write";

export type QoderPermissionContext = {
  approvalPolicy?: string;
  cwd: string;
  invocationRef: string;
  onEvent?: (event: ProviderEvent) => void;
  sandbox?: string;
  session: () => SessionRef | undefined;
};

type PendingPermission = {
  cleanup: () => void;
  context: QoderPermissionContext;
  id: string;
  inputSummary: string;
  path: string;
  options: CanUseToolOptions;
  resolve: (result: PermissionResult) => void;
  toolName: string;
};

export type QoderPermissionBrokerOptions = {
  timeoutMs?: number;
};

export class QoderPermissionBroker {
  private readonly pending = new Map<string, PendingPermission>();
  private readonly timeoutMs: number;

  constructor(options: QoderPermissionBrokerOptions = {}) {
    this.timeoutMs = Math.max(1, options.timeoutMs ?? 5 * 60_000);
  }

  callback(context: QoderPermissionContext): CanUseTool {
    return async (toolName, input, options) => {
      const policy = normalizePolicy(context.approvalPolicy);
      const sandbox = normalizeSandbox(context.sandbox);
      if (READ_TOOLS.includes(toolName as typeof READ_TOOLS[number])) return allowResult(options.toolUseID);
      if (sandbox === "read-only") return denyResult(options.toolUseID, "Qoder read-only policy denies side-effect tools");
      if (BLOCKED_TOOLS.includes(toolName as typeof BLOCKED_TOOLS[number])) {
        return denyResult(options.toolUseID, "Qoder permission policy cannot provide OS-level containment for this tool");
      }
      if (!WRITE_TOOLS.has(toolName)) return denyResult(options.toolUseID, `Qoder tool ${toolName} is not in the workspace policy`);
      if (!await inputPathWithinWorkspace(input, context.cwd)) {
        return denyResult(options.toolUseID, "Qoder write path is outside or cannot be proven inside the workspace");
      }
      if (policy === "never") return allowResult(options.toolUseID);
      return await this.request(toolName, input, options, context);
    };
  }

  async resolveApproval(requestId: string, decision: ApprovalDecision): Promise<void> {
    const id = requestId.trim();
    const pending = this.pending.get(id);
    if (!pending) throw new Error(`Qoder approval request is not pending: ${id}`);
    const scoped = constrainApprovalGrantScope(decision, {
      provider: "qoder",
      requestType: WRITE_TOOLS.has(pending.toolName) ? "fileChange" : "permissions",
      sessionId: pending.context.session()?.sessionId
    });
    const approved = scoped.decision.decision === "approve";
    this.finish(pending, approved
      ? allowResult(pending.options.toolUseID)
      : denyResult(pending.options.toolUseID, "Qoder tool use was denied", cancelledDecision(decision)), {
      decision: approved ? "approve" : cancelledDecision(decision) ? "cancel" : "deny",
      reason: scoped.audit.scope_reason,
      scope: scoped.decision.scope ?? "turn"
    });
  }

  rejectInvocation(invocationRef: string, reason = "Qoder invocation interrupted"): void {
    for (const pending of [...this.pending.values()]) {
      if (pending.context.invocationRef !== invocationRef) continue;
      this.finish(pending, denyResult(pending.options.toolUseID, reason, true), {
        decision: "cancel",
        reason,
        scope: "turn"
      });
    }
  }

  rejectAll(reason = "Qoder provider restarted while approval was pending"): void {
    for (const pending of [...this.pending.values()]) {
      this.finish(pending, denyResult(pending.options.toolUseID, reason, true), {
        decision: "cancel",
        reason,
        scope: "turn"
      });
    }
  }

  pendingCount(): number {
    return this.pending.size;
  }

  private async request(
    toolName: string,
    input: Record<string, unknown>,
    options: CanUseToolOptions,
    context: QoderPermissionContext
  ): Promise<PermissionResult> {
    if (options.signal.aborted) {
      return denyResult(options.toolUseID, "Qoder approval was interrupted before it could be requested", true);
    }
    const session = context.session();
    const id = `${session?.sessionId || context.invocationRef}:${options.toolUseID}`;
    if (this.pending.has(id)) return denyResult(options.toolUseID, "Duplicate Qoder approval request denied");
    return await new Promise<PermissionResult>((resolvePermission) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const abort = () => {
        const pending = this.pending.get(id);
        if (pending) this.finish(pending, denyResult(options.toolUseID, "Qoder approval was interrupted", true), {
          decision: "cancel", reason: "permission callback aborted", scope: "turn"
        });
      };
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        options.signal.removeEventListener("abort", abort);
      };
      const pending: PendingPermission = {
        cleanup,
        context,
        id,
        inputSummary: toolInputSummary(input, context.cwd),
        path: redactedPath(firstText(input.file_path, input.path, input.notebook_path), context.cwd),
        options,
        resolve: resolvePermission,
        toolName
      };
      this.pending.set(id, pending);
      options.signal.addEventListener("abort", abort, { once: true });
      timer = setTimeout(() => {
        const current = this.pending.get(id);
        if (current) this.finish(current, denyResult(options.toolUseID, "Qoder approval timed out"), {
          decision: "deny", reason: "approval timeout", scope: "turn"
        });
      }, this.timeoutMs);
      try {
        context.onEvent?.(permissionEvent(pending, "approval/requested", "pending"));
      } catch {
        this.finish(pending, denyResult(options.toolUseID, "Qoder approval event could not be recorded"), {
          decision: "deny", reason: "approval event persistence failed", scope: "turn"
        });
      }
    });
  }

  private finish(
    pending: PendingPermission,
    result: PermissionResult,
    resolution: { decision: string; reason: string; scope: string }
  ): void {
    if (this.pending.get(pending.id) !== pending) return;
    this.pending.delete(pending.id);
    pending.cleanup();
    pending.resolve(result);
    try {
      pending.context.onEvent?.(permissionEvent(pending, "approval/resolved", resolution.decision, resolution));
    } catch {
      // The permission is already fail-closed or explicitly resolved; audit delivery cannot reopen it.
    }
  }
}

export function qoderPermissionOptions(
  approvalPolicy: string | undefined,
  sandboxValue: string | undefined,
  canUseTool?: CanUseTool
): Pick<Options, "allowedTools" | "canUseTool" | "disallowedTools" | "permissionMode" | "tools"> {
  const approval = normalizePolicy(approvalPolicy);
  const sandbox = normalizeSandbox(sandboxValue);
  if (approval !== "never" && !canUseTool) {
    throw new Error(`Qoder approval policy ${approval} requires a canUseTool callback`);
  }
  const tools = sandbox === "read-only" ? [...READ_TOOLS] : [...READ_TOOLS, "Edit", "Write"];
  return {
    allowedTools: approval === "never" ? tools : [...READ_TOOLS],
    ...(canUseTool ? { canUseTool } : {}),
    disallowedTools: sandbox === "read-only" ? [...BLOCKED_TOOLS, "Edit", "Write"] : [...BLOCKED_TOOLS],
    permissionMode: approval === "never"
      ? sandbox === "workspace-write" ? "acceptEdits" : "dontAsk"
      : "default",
    tools
  };
}

function permissionEvent(
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
      agent_id: clean(pending.options.agentID),
      blocked_path: redactedPath(pending.options.blockedPath, pending.context.cwd),
      decision_reason: redactSensitiveText(clean(pending.options.decisionReason)),
      description: redactSensitiveText(clean(pending.options.description)),
      display_name: redactSensitiveText(clean(pending.options.displayName)),
      path: WRITE_TOOLS.has(pending.toolName) ? pending.path : "",
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

function normalizePolicy(value: string | undefined): QoderApprovalPolicy {
  const policy = clean(value) || "never";
  if (policy === "never" || policy === "danger-only" || policy === "always") return policy;
  throw new Error(`Unsupported Qoder approval policy ${policy}`);
}

function normalizeSandbox(value: string | undefined): QoderSandbox {
  const sandbox = clean(value) || "workspace-write";
  if (sandbox === "danger-full-access") {
    throw new Error("Qoder danger-full-access is disabled because Qoder permission policy is not an OS sandbox");
  }
  if (sandbox === "read-only" || sandbox === "workspace-write") return sandbox;
  throw new Error(`Unsupported Qoder sandbox ${sandbox}`);
}

async function inputPathWithinWorkspace(input: Record<string, unknown>, cwdValue: string): Promise<boolean> {
  const cwd = clean(cwdValue);
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

function toolInputSummary(input: Record<string, unknown>, cwd: string): string {
  const safe = redactionRegistry.redactValue({
    command: clean(input.command ?? input.cmd),
    path: redactedPath(firstText(input.file_path, input.path, input.notebook_path), cwd),
    description: redactSensitiveText(clean(input.description))
  });
  const text = JSON.stringify(safe);
  return text.length > 320 ? `${text.slice(0, 319)}…` : text;
}

function redactedPath(value: unknown, cwdValue: string): string {
  const path = clean(value);
  const cwd = clean(cwdValue);
  if (!path) return "";
  const absolute = isAbsolute(path) ? resolve(path) : isAbsolute(cwd) ? resolve(cwd, path) : "";
  if (absolute && isAbsolute(cwd)) {
    const scoped = relative(resolve(cwd), absolute);
    if (scoped === "") return "<workspace>";
    if (!scoped.startsWith("..") && !isAbsolute(scoped)) return `<workspace>/${scoped}`;
  }
  return "<redacted-path>";
}

function allowResult(toolUseID: string): PermissionResult {
  return { behavior: "allow", decisionClassification: "user_temporary", toolUseID };
}

function denyResult(toolUseID: string, message: string, interrupt = false): PermissionResult {
  return {
    behavior: "deny",
    decisionClassification: "user_reject",
    ...(interrupt ? { interrupt: true } : {}),
    message: redactSensitiveText(message),
    toolUseID
  };
}

function cancelledDecision(decision: ApprovalDecision): boolean {
  return ["abort", "cancel"].includes(clean(decision.decision));
}

function firstText(...values: unknown[]): string {
  return values.map(clean).find(Boolean) ?? "";
}

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function missingPath(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}
