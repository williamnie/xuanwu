import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { CanUseTool, PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import type { ResolvedExecutionPolicy } from "../core/policyContracts.ts";
import { normalizedRunEvent } from "../runEvents.ts";
import type { ApprovalDecision, ProviderEvent, SessionRef } from "../types.ts";
import { redactSensitiveText } from "../../util/redact.ts";

const READ_TOOLS = new Set(["Read", "Grep", "Glob", "LS"]);
const PATH_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);

type ClaudePermissionContext = {
  cwd: string;
  invocationRef: string;
  onEvent?: (event: ProviderEvent) => void;
  policy: ResolvedExecutionPolicy;
  session: () => SessionRef | undefined;
};

type ClaudePermissionOptions = Parameters<CanUseTool>[2];
type Pending = {
  cleanup: () => void;
  context: ClaudePermissionContext;
  id: string;
  input: Record<string, unknown>;
  options: ClaudePermissionOptions;
  resolve: (result: PermissionResult) => void;
  toolName: string;
};

export class ClaudePermissionBroker {
  private readonly pending = new Map<string, Pending>();
  constructor(private readonly timeoutMs = 5 * 60_000) {}

  callback(context: ClaudePermissionContext): CanUseTool {
    return async (toolName, input, options) => {
      if (READ_TOOLS.has(toolName)) return allow(options.toolUseID);
      const access = context.policy.requested.access;
      if (access === "read-only") return deny(options.toolUseID, "Claude read-only policy denies side-effect tools");
      if (PATH_TOOLS.has(toolName) && !await pathWithinProject(input, context.cwd)) {
        return deny(options.toolUseID, "Claude write path is outside or cannot be proven inside the project");
      }
      if (access === "provider-native-development") {
        if (toolName === "Bash" && !routineCommand(input)) {
          return deny(options.toolUseID, "Claude project-scoped policy denies commands that cannot be proven to stay within normal development effects");
        }
        if (!PATH_TOOLS.has(toolName) && toolName !== "Bash") {
          return deny(options.toolUseID, `Claude tool ${toolName} is outside the project development policy`);
        }
      }
      const approval = context.policy.requested.approval;
      if (approval === "unattended") return allow(options.toolUseID);
      if (approval === "ask-sensitive" && sensitivity(toolName, input) === "routine") return allow(options.toolUseID);
      return await this.request(toolName, input, options, context);
    };
  }

  async resolveApproval(id: string, decision: ApprovalDecision): Promise<void> {
    const pending = this.pending.get(id.trim());
    if (!pending) throw new Error(`Claude approval request is not pending: ${id.trim()}`);
    const approved = ["approve", "allow"].includes(decision.decision.trim().toLowerCase());
    this.finish(pending, approved ? allow(pending.options.toolUseID) : deny(pending.options.toolUseID, "Claude tool use was denied"), approved ? "approve" : "deny");
  }

  rejectInvocation(invocationRef: string, reason: string): void {
    for (const pending of [...this.pending.values()]) {
      if (pending.context.invocationRef === invocationRef) this.finish(pending, deny(pending.options.toolUseID, reason, true), "cancel");
    }
  }

  rejectAll(reason: string): void {
    for (const pending of [...this.pending.values()]) this.finish(pending, deny(pending.options.toolUseID, reason, true), "cancel");
  }

  private request(toolName: string, input: Record<string, unknown>, options: ClaudePermissionOptions, context: ClaudePermissionContext): Promise<PermissionResult> {
    if (options.signal.aborted) return Promise.resolve(deny(options.toolUseID, "Claude approval callback was interrupted", true));
    const id = `${context.invocationRef}:${options.toolUseID}`;
    if (this.pending.has(id)) return Promise.resolve(deny(options.toolUseID, "Duplicate Claude approval request denied"));
    return new Promise((resolvePermission) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const abort = () => {
        const current = this.pending.get(id);
        if (current) this.finish(current, deny(options.toolUseID, "Claude approval callback was interrupted", true), "cancel");
      };
      const pending: Pending = {
        cleanup: () => {
          if (timer) clearTimeout(timer);
          options.signal.removeEventListener("abort", abort);
        },
        context,
        id,
        input,
        options,
        resolve: resolvePermission,
        toolName
      };
      this.pending.set(id, pending);
      options.signal.addEventListener("abort", abort, { once: true });
      timer = setTimeout(() => this.finish(pending, deny(options.toolUseID, "Claude approval timed out"), "timeout"), Math.max(1, this.timeoutMs));
      timer.unref?.();
      try {
        context.onEvent?.(approvalEvent(pending, "approval/requested", "pending"));
      } catch {
        this.finish(pending, deny(options.toolUseID, "Claude approval request could not be recorded"), "deny");
      }
    });
  }

  private finish(pending: Pending, result: PermissionResult, decision: string): void {
    if (this.pending.get(pending.id) !== pending) return;
    this.pending.delete(pending.id);
    pending.cleanup();
    pending.resolve(result);
    try { pending.context.onEvent?.(approvalEvent(pending, "approval/resolved", decision)); } catch {}
  }
}

function approvalEvent(pending: Pending, method: "approval/requested" | "approval/resolved", status: string): ProviderEvent {
  const session = pending.context.session();
  const payload = {
    id: pending.id,
    method: "claude/canUseTool",
    params: {
      callback_owner_ref: pending.context.invocationRef,
      invocation_ref: pending.context.invocationRef,
      policy_revision: pending.context.policy.contract,
      tool_name: pending.toolName,
      tool_use_id: pending.options.toolUseID,
      threadId: session?.sessionId ?? "",
      turnId: session?.turnId ?? "",
      tool_input_summary: inputSummary(pending.input, pending.context.cwd)
    }
  };
  const resolved = method === "approval/resolved";
  return {
    payload,
    provider: "claude",
    raw: { method, payload },
    runEvent: normalizedRunEvent({
      kind: resolved ? "approval_resolved" : "approval_requested",
      method,
      outcome: resolved ? "running" : "waiting_approval",
      provider: "claude",
      session
    }),
    session,
    status,
    type: "approval"
  };
}

async function pathWithinProject(input: Record<string, unknown>, cwdValue: string): Promise<boolean> {
  const cwd = text(cwdValue);
  const path = firstText(input.file_path, input.path, input.notebook_path);
  if (!isAbsolute(cwd) || path === "") return false;
  try {
    const project = await realpath(cwd);
    let probe = resolve(cwd, path);
    while (true) {
      try {
        const target = await realpath(probe);
        const scoped = relative(project, target);
        return scoped === "" || (!scoped.startsWith("..") && !isAbsolute(scoped));
      } catch (error) {
        if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") return false;
        const parent = dirname(probe);
        if (parent === probe) return false;
        probe = parent;
      }
    }
  } catch { return false; }
}

function routineCommand(input: Record<string, unknown>): boolean {
  const command = firstText(input.command, input.cmd);
  return /^(?:git\s+(?:status|diff|show|log)(?:\s|$)|(?:bun|npm|pnpm|yarn)\s+(?:test|run\s+(?:test|lint|build|format|check))(?:\s|$)|(?:cargo|go)\s+(?:test|check|build)(?:\s|$)|(?:pytest|python\s+-m\s+pytest|swift\s+test|xcodebuild\b))/.test(command);
}

function sensitivity(toolName: string, input: Record<string, unknown>): "routine" | "sensitive" {
  if (PATH_TOOLS.has(toolName)) return "routine";
  if (toolName === "Bash") return routineCommand(input) ? "routine" : "sensitive";
  return "sensitive";
}

function inputSummary(input: Record<string, unknown>, cwd: string): string {
  const path = firstText(input.file_path, input.path, input.notebook_path);
  const command = firstText(input.command, input.cmd);
  const normalizedPath = path === "" ? "" : isAbsolute(path) ? "<absolute-path>" : path.slice(0, 160);
  return redactSensitiveText(JSON.stringify({ ...(command ? { command: command.slice(0, 160) } : {}), ...(normalizedPath ? { path: normalizedPath } : {}), cwd: cwd ? "<project>" : "" })).slice(0, 320);
}

function allow(toolUseID: string): PermissionResult { return { behavior: "allow", toolUseID, decisionClassification: "user_temporary" }; }
function deny(toolUseID: string, message: string, interrupt = false): PermissionResult {
  return { behavior: "deny", toolUseID, message: redactSensitiveText(message), ...(interrupt ? { interrupt: true } : {}), decisionClassification: "user_reject" };
}
function firstText(...values: unknown[]): string { return values.map(text).find(Boolean) ?? ""; }
function text(value: unknown): string { return typeof value === "string" ? value.trim() : ""; }
