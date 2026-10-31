import { resolve } from "node:path";
import type { CanUseToolOptions, PermissionResult } from "@qoder-ai/qoder-agent-sdk";
import type { ProviderEvent, SessionRef } from "../types.ts";
import type { ResolvedExecutionPolicy } from "../core/policyContracts.ts";

export const READ_TOOLS = ["Read", "Grep", "Glob"] as const;

export const WRITE_TOOLS = new Set(["Edit", "Write"]);

export const BLOCKED_TOOLS = ["Agent", "Bash", "NotebookEdit"] as const;

export type QoderApprovalPolicy = "never" | "danger-only" | "always";

export type QoderSandbox = "danger-full-access" | "read-only" | "workspace-write";

export type QoderPermissionContext = {
  approvalPolicy?: string;
  cwd: string;
  invocationRef: string;
  onEvent?: (event: ProviderEvent) => void;
  policy?: ResolvedExecutionPolicy;
  sandbox?: string;
  session: () => SessionRef | undefined;
};

export type PendingPermission = {
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
