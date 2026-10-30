import { resolve } from "node:path";
import type { CanUseTool, CanUseToolOptions, PermissionResult } from "@qoder-ai/qoder-agent-sdk";
import { constrainApprovalGrantScope } from "../../pi/actions/approvalGrantScope.ts";
import type { ApprovalDecision } from "../types.ts";
import { PendingPermission, QoderPermissionBrokerOptions, QoderPermissionContext, READ_TOOLS, BLOCKED_TOOLS, WRITE_TOOLS } from "./permissionModel.ts";
import { toolSensitivity, routineDevelopmentCommand } from "./permissionPolicy.ts";
import { normalizePolicy, normalizeSandbox, allowResult, denyResult, inputPathWithinWorkspace, cancelledDecision, toolInputSummary, redactedPath, firstText, permissionEvent } from "./permissionProjection.ts";

export class QoderPermissionBroker {
  private readonly pending = new Map<string, PendingPermission>();
  private readonly timeoutMs: number;

  constructor(options: QoderPermissionBrokerOptions = {}) {
    this.timeoutMs = Math.max(1, options.timeoutMs ?? 5 * 60_000);
  }

  callback(context: QoderPermissionContext): CanUseTool {
    return async (toolName, input, options) => {
      if (context.policy) return await this.policyDecision(toolName, input, options, context);
      const policy = normalizePolicy(context.approvalPolicy);
      const sandbox = normalizeSandbox(context.sandbox);
      if (READ_TOOLS.includes(toolName as typeof READ_TOOLS[number])) return allowResult(options.toolUseID);
      if (sandbox === "read-only") return denyResult(options.toolUseID, "Qoder read-only policy denies side-effect tools");
      if (sandbox === "danger-full-access") {
        if (policy === "never") return allowResult(options.toolUseID);
        if (policy === "danger-only" && toolSensitivity(toolName, input, context.cwd) === "routine") {
          return allowResult(options.toolUseID);
        }
        return await this.request(toolName, input, options, context);
      }
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

  private async policyDecision(
    toolName: string,
    input: Record<string, unknown>,
    options: CanUseToolOptions,
    context: QoderPermissionContext
  ): Promise<PermissionResult> {
    const policy = context.policy!;
    if (READ_TOOLS.includes(toolName as typeof READ_TOOLS[number])) return allowResult(options.toolUseID);
    if (policy.requested.access === "read-only") {
      return denyResult(options.toolUseID, "Qoder read-only policy denies side-effect tools");
    }
    const pathTool = WRITE_TOOLS.has(toolName) || toolName === "NotebookEdit";
    if (pathTool && !await inputPathWithinWorkspace(input, context.cwd)) {
      return denyResult(options.toolUseID, "Qoder write path is outside or cannot be proven inside the project");
    }
    if (policy.requested.access === "provider-native-development") {
      if (toolName === "Bash" && !routineDevelopmentCommand(input)) {
        return denyResult(options.toolUseID, "Qoder project-scoped policy denies commands that cannot be proven to stay within normal development effects");
      }
      if (!pathTool && toolName !== "Bash") {
        return denyResult(options.toolUseID, `Qoder tool ${toolName} is outside the project development policy`);
      }
    }
    if (policy.requested.approval === "unattended") return allowResult(options.toolUseID);
    if (policy.requested.approval === "ask-sensitive" && toolSensitivity(toolName, input, context.cwd) === "routine") {
      return allowResult(options.toolUseID);
    }
    return await this.request(toolName, input, options, context);
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

export { qoderPermissionOptions } from "./permissionPolicy.ts";
