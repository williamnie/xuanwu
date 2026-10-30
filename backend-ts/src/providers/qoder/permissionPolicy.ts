import type { CanUseTool, Options } from "@qoder-ai/qoder-agent-sdk";
import type { ResolvedExecutionPolicy } from "../core/policyContracts.ts";
import { cleanString } from "../../util/values.ts";
import { READ_TOOLS, BLOCKED_TOOLS, WRITE_TOOLS } from "./permissionModel.ts";
import { normalizePolicy, normalizeSandbox, firstText, redactedPath } from "./permissionProjection.ts";

export function qoderPermissionOptions(
  approvalPolicy: string | undefined,
  sandboxValue: string | undefined,
  canUseTool?: CanUseTool,
  resolvedPolicy?: ResolvedExecutionPolicy
): Pick<Options, "allowDangerouslySkipPermissions" | "allowedTools" | "canUseTool" | "disallowedTools" | "permissionMode" | "tools"> {
  if (resolvedPolicy) {
    const native = resolvedPolicy.nativeSummary;
    const tools = stringArray(native.tools);
    const permissionMode = cleanString(native.permissionMode);
    const bridge = native.approvalBridge === true;
    const requireCallback = bridge || (resolvedPolicy.requested.access === "provider-native-development" && resolvedPolicy.requested.approval === "unattended");
    if (requireCallback && !canUseTool) throw new Error("Qoder resolved execution policy requires a canUseTool callback");
    return {
      allowDangerouslySkipPermissions: native.allowDangerouslySkipPermissions === true,
      allowedTools: resolvedPolicy.requested.access === "read-only" ? [...READ_TOOLS] : [...READ_TOOLS],
      ...(canUseTool ? { canUseTool } : {}),
      disallowedTools: resolvedPolicy.requested.access === "read-only"
        ? ["Agent", "Bash", "Edit", "Write", "NotebookEdit"]
        : [],
      permissionMode: permissionMode as Options["permissionMode"],
      tools
    };
  }
  const approval = normalizePolicy(approvalPolicy);
  const sandbox = normalizeSandbox(sandboxValue);
  if (sandbox === "danger-full-access" && approval === "never") {
    return {
      allowDangerouslySkipPermissions: true,
      allowedTools: [...READ_TOOLS],
      disallowedTools: [],
      permissionMode: "bypassPermissions",
      tools: [...READ_TOOLS, "Edit", "Write", "Bash", "NotebookEdit"]
    };
  }
  // workspace-write must always pass through the broker so its path/symlink
  // containment checks cannot be bypassed by an SDK auto-approval mode.
  if ((approval !== "never" || sandbox === "workspace-write") && !canUseTool) {
    throw new Error(`Qoder approval policy ${approval} requires a canUseTool callback`);
  }
  const tools = sandbox === "read-only" ? [...READ_TOOLS] : [...READ_TOOLS, "Edit", "Write"];
  return {
    allowDangerouslySkipPermissions: false,
    allowedTools: [...READ_TOOLS],
    ...(canUseTool ? { canUseTool } : {}),
    disallowedTools: sandbox === "read-only" ? [...BLOCKED_TOOLS, "Edit", "Write"] : [...BLOCKED_TOOLS],
    permissionMode: approval === "never" && sandbox === "read-only" ? "dontAsk" : "default",
    tools
  };
}

export function toolSensitivity(toolName: string, input: Record<string, unknown>, cwd: string): "routine" | "sensitive" {
  if (WRITE_TOOLS.has(toolName)) return "routine";
  if (toolName === "NotebookEdit") return "routine";
  if (toolName === "Bash") return routineDevelopmentCommand(input) ? "routine" : "sensitive";
  const path = firstText(input.file_path, input.path, input.notebook_path);
  return path && redactedPath(path, cwd).startsWith("<workspace>") ? "routine" : "sensitive";
}

export function routineDevelopmentCommand(input: Record<string, unknown>): boolean {
  const command = cleanString(input.command ?? input.cmd);
  if (command === "") return false;
  return /^(?:git\s+(?:status|diff|show|log)(?:\s|$)|(?:bun|npm|pnpm|yarn)\s+(?:test|run\s+(?:test|lint|build|format|check))(?:\s|$)|(?:cargo|go)\s+(?:test|check|build)(?:\s|$)|(?:pytest|python\s+-m\s+pytest|swift\s+test|xcodebuild\b))/.test(command);
}

export function stringArray(value: unknown): string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : [];
}
