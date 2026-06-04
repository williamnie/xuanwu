export const PI_MANAGER_ROLE = "pi_manager" as const;

export const EXECUTION_AGENT_ROLES = ["executor", "verifier", "reviewer", "reporter"] as const;
export const AGENT_SESSION_ROLES = [PI_MANAGER_ROLE, ...EXECUTION_AGENT_ROLES] as const;

export type AgentSessionRole = (typeof AGENT_SESSION_ROLES)[number];
export type ExecutionAgentRole = (typeof EXECUTION_AGENT_ROLES)[number];

export function normalizeAgentSessionRole(value: unknown): AgentSessionRole | "" {
  const role = roleText(value);
  if (role === "") return "";
  if (role === "pi") return PI_MANAGER_ROLE;
  if (isAgentSessionRole(role)) return role;
  throw new Error("agent role 不合法");
}

export function normalizeExecutionAgentRole(value: unknown): ExecutionAgentRole {
  const role = roleText(value) || "executor";
  if (isExecutionAgentRole(role)) return role;
  throw new Error("agent role 不合法");
}

export function isAgentSessionRole(value: string): value is AgentSessionRole {
  return (AGENT_SESSION_ROLES as readonly string[]).includes(value);
}

export function isExecutionAgentRole(value: string): value is ExecutionAgentRole {
  return (EXECUTION_AGENT_ROLES as readonly string[]).includes(value);
}

function roleText(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}
