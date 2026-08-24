import type { RunnerDatabase } from "../db/database.ts";
import { createPiProjectTools } from "../http/piProjectTools.ts";
import type {
  AssistantTool,
  PiRuntimeToolPolicy,
  PiRuntimeToolProfile,
  ToolJsonSchema,
  ToolPermission,
  ToolProvider
} from "./toolProviderEnvelope.ts";
import {
  supervisorControlOutputSchema,
  SUPERVISOR_CONTROL_DANGEROUS_TOOL_NAMES,
  SUPERVISOR_CONTROL_READ_TOOL_NAMES,
  SUPERVISOR_CONTROL_TOOL_NAMES
} from "./supervisorControlContracts.ts";
import { PI_LOCAL_WORKSPACE_TOOL_NAMES } from "./localWorkspaceTools.ts";

export const RUNNER_BUILTIN_PROVIDER_ID = "runner-builtin";
const PRIMITIVE_READ_TOOL_NAMES = ["read", "grep", "find", "ls"] as const;
const READ_TOOL_NAMES = new Set<string>([
  ...PRIMITIVE_READ_TOOL_NAMES,
  "issue_list",
  "issue_status_summary",
  "issue_execution_status",
  "issue_read",
  "issue_state_diagnose",
  "issue_completion_watch_list",
  "repo_search",
  "repo_read_excerpt",
  "repo_tree",
  "project_status",
  "project_list",
  "runner_settings_read",
  "session_list",
  "session_read_summary",
  "skill_list",
  "skill_read",
  "skill_recommend",
  "mcp_registry_list",
  "mcp_capability_read",
  "mcp_requirement_recommend",
  "mcp_resource_list",
  "mcp_resource_read",
  "memory_search",
  "notification_preference_read",
  ...SUPERVISOR_CONTROL_READ_TOOL_NAMES
]);
const DANGEROUS_TOOL_NAMES = new Set<string>([
  "issue_delete",
  "runner_settings_update",
  "system_restart",
  ...SUPERVISOR_CONTROL_DANGEROUS_TOOL_NAMES
]);
const SUPERVISOR_CONTROL_TOOLS = new Set<string>(SUPERVISOR_CONTROL_TOOL_NAMES);
const LOCAL_WORKSPACE_TOOLS = new Set<string>(PI_LOCAL_WORKSPACE_TOOL_NAMES);
const CHAT_BOOTSTRAP_TOOLS = new Set([
  "project_status", "project_list", "issue_list", "issue_status_summary", "issue_execution_status", "issue_read",
  "project_create", "workspace_make_directory", "workspace_write_file", "manual_context_intake",
  "issue_create_proposal", "issue_create_batch_proposal", "issue_enqueue_proposal", "issue_schedule_enqueue", "issue_status_update",
  "issue_completion_watch_create", "issue_completion_watch_list", "issue_completion_watch_cancel",
  "notification_preference_read", "notification_preference_update",
  "session_list", "session_read_summary", "work_list", "work_read", "memory_search",
  "repo_search", "repo_read_excerpt", "repo_tree", "memory_remember"
]);
const REVIEW_TOOLS = new Set([
  "project_status", "project_list", "issue_list", "issue_status_summary", "issue_execution_status", "issue_read",
  "project_create", "workspace_make_directory", "workspace_write_file", "manual_context_intake",
  "session_list", "session_read_summary", "repo_search", "repo_read_excerpt", "repo_tree",
  "work_list", "work_read", "run_list", "run_read", "memory_search", "memory_remember", "skill_list", "skill_read"
]);
const ACCEPTANCE_TOOLS = new Set([
  "issue_read", "session_read_summary", "repo_search", "repo_read_excerpt", "repo_tree"
]);
const RECOVERY_TOOLS = new Set([
  "issue_read", "issue_state_diagnose", "session_read_summary", "project_status", "memory_search"
]);
const MANAGER_CYCLE_TOOLS = new Set([
  "project_status", "issue_list", "issue_status_summary", "issue_execution_status", "issue_read",
  "issue_comment", "issue_enqueue_next_triage", "issue_enqueue_batch_triage", "issue_state_diagnose",
  "work_list", "work_read", "work_control", "run_list", "run_read",
  "memory_search", "memory_remember", "review_workflow_request", "report_workflow_request"
]);
const TOOL_ALIASES: Record<string, string[]> = {
  issue_completion_watch_cancel: ["cancel completion notification", "取消完成提醒", "取消结果通知"],
  issue_completion_watch_create: [
    "issue completion watch notification",
    "create a completion notification watch",
    "completion notification",
    "完成提醒",
    "结果通知",
    "有结果通知我"
  ],
  issue_completion_watch_list: ["list completion notifications", "查看完成提醒", "查看结果通知"],
  issue_status_summary: ["unfinished issue count", "issue count", "未完成 issue 数量", "还有多少 issue 没做"],
  notification_preference_read: ["read notification preferences", "查看通知设置"],
  notification_preference_update: ["update notification preferences", "修改通知设置"]
};

export function listBuiltinToolProviders(): ToolProvider[] {
  return [{
    audit: { redact: [] },
    description: "Builtin Supervisor and Runner tools exposed by the local runtime.",
    id: RUNNER_BUILTIN_PROVIDER_ID,
    kind: "builtin",
    metadata: { builtin: true },
    name: "Runner builtin",
    status: "enabled"
  }];
}

export function listBuiltinAssistantTools(): AssistantTool[] {
  return [...primitiveReadTools(), ...piActionTools()].sort(compareTools);
}

function piActionTools(): AssistantTool[] {
  const tools = createPiProjectTools({} as RunnerDatabase);
  return tools.map((tool) => {
    const permission = builtinToolPermission(tool.name);
    return {
      audit: SUPERVISOR_CONTROL_TOOLS.has(tool.name) || LOCAL_WORKSPACE_TOOLS.has(tool.name)
        ? { category: "supervisor_domain_control", redact: [], retention: "extended", tags: [permission] }
        : { redact: [] },
      description: tool.description,
      input_schema: plainSchema(tool.parameters),
      metadata: {
        builtin: true,
        label: tool.label ?? tool.name,
        risk_level: toolRiskLevel(permission),
        xuanwu_runtime: runtimePolicy(tool.name, permission)
      },
      name: tool.name,
      output_schema: supervisorControlOutputSchema(tool.name) ?? { type: "object" },
      permission,
      provider_id: RUNNER_BUILTIN_PROVIDER_ID
    };
  });
}

function primitiveReadTools(): AssistantTool[] {
  return PRIMITIVE_READ_TOOL_NAMES.map((name) => ({
    audit: { redact: [] },
    description: primitiveDescription(name),
    input_schema: primitiveSchema(name),
    metadata: {
      builtin: true,
      label: name,
      risk_level: "low",
      xuanwu_runtime: runtimePolicy(name, "read")
    },
    name,
    output_schema: { type: "object" },
    permission: "read",
    provider_id: RUNNER_BUILTIN_PROVIDER_ID
  }));
}

export function builtinToolPermission(name: string): ToolPermission {
  if (DANGEROUS_TOOL_NAMES.has(name)) return "dangerous";
  return READ_TOOL_NAMES.has(name) ? "read" : "write";
}

function toolRiskLevel(permission: ToolPermission): "high" | "low" | "medium" {
  if (permission === "read") return "low";
  if (permission === "dangerous") return "high";
  return "medium";
}

function runtimePolicy(name: string, permission: ToolPermission): PiRuntimeToolPolicy {
  const profiles: PiRuntimeToolProfile[] = [];
  if (CHAT_BOOTSTRAP_TOOLS.has(name) || PRIMITIVE_READ_TOOL_NAMES.includes(name as never)) profiles.push("chat");
  if (REVIEW_TOOLS.has(name) || PRIMITIVE_READ_TOOL_NAMES.includes(name as never)) profiles.push("review");
  if (ACCEPTANCE_TOOLS.has(name) || PRIMITIVE_READ_TOOL_NAMES.includes(name as never)) profiles.push("acceptance");
  if (RECOVERY_TOOLS.has(name) || PRIMITIVE_READ_TOOL_NAMES.includes(name as never)) profiles.push("recovery");
  if (MANAGER_CYCLE_TOOLS.has(name) || PRIMITIVE_READ_TOOL_NAMES.includes(name as never)) profiles.push("manager_cycle");
  return {
    aliases: TOOL_ALIASES[name] ?? [],
    family: toolFamily(name),
    profiles,
    risk_level: toolRiskLevel(permission)
  };
}

function toolFamily(name: string): string {
  if (name.startsWith("issue_completion_watch_")) return "issue.notification";
  if (name.startsWith("notification_preference_")) return "notification.preference";
  const prefix = name.split("_", 1)[0] ?? "";
  return prefix || "uncategorized";
}

function primitiveDescription(name: string): string {
  if (name === "read") return "Read a bounded file excerpt through Supervisor runtime.";
  if (name === "grep") return "Search text through Supervisor runtime.";
  if (name === "find") return "Find files through Supervisor runtime.";
  return "List directory entries through Supervisor runtime.";
}

function primitiveSchema(name: string): ToolJsonSchema {
  if (name === "grep") return objectSchema({ pattern: { type: "string" }, path: { type: "string" } }, ["pattern"]);
  if (name === "find") return objectSchema({ name: { type: "string" }, path: { type: "string" } });
  return objectSchema({ path: { type: "string" } }, ["path"]);
}

function objectSchema(properties: Record<string, unknown>, required: string[] = []): ToolJsonSchema {
  return { additionalProperties: false, properties, required, type: "object" };
}

function plainSchema(value: unknown): ToolJsonSchema {
  try {
    return JSON.parse(JSON.stringify(value ?? {}));
  } catch {
    return {};
  }
}

function compareTools(left: AssistantTool, right: AssistantTool): number {
  return left.name.localeCompare(right.name);
}
