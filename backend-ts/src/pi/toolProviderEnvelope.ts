export const TOOL_PROVIDER_KINDS = ["builtin", "cli", "mcp", "http", "browser"] as const;
export const TOOL_PERMISSIONS = ["read", "write", "dangerous"] as const;
export const TOOL_RESULT_STATUSES = ["succeeded", "failed", "timeout", "denied"] as const;

export type ToolProviderKind = (typeof TOOL_PROVIDER_KINDS)[number];
export type ToolPermission = (typeof TOOL_PERMISSIONS)[number];
export type ToolResultStatus = (typeof TOOL_RESULT_STATUSES)[number];
export type ToolJsonSchema = Record<string, unknown>;
export type ToolEnvelopeMetadata = Record<string, unknown>;

export const PI_RUNTIME_TOOL_PROFILES = [
  "chat",
  "review",
  "acceptance",
  "recovery",
  "manager_cycle"
] as const;

export type PiRuntimeToolProfile = (typeof PI_RUNTIME_TOOL_PROFILES)[number];

export type PiRuntimeToolPolicy = {
  aliases: string[];
  family: string;
  profiles: PiRuntimeToolProfile[];
  risk_level: "low" | "medium" | "high";
};

export type ToolAuditMetadata = {
  redact: string[];
  actor?: string;
  category?: string;
  retention?: "ephemeral" | "standard" | "extended";
  tags?: string[];
  metadata?: ToolEnvelopeMetadata;
};

export type ToolProvider = {
  id: string;
  kind: ToolProviderKind;
  name: string;
  description?: string;
  status?: "enabled" | "disabled" | "degraded";
  version?: string;
  default_timeout_ms?: number;
  audit?: ToolAuditMetadata;
  metadata?: ToolEnvelopeMetadata;
};

export type AssistantTool = {
  name: string;
  provider_id: string;
  description: string;
  input_schema: ToolJsonSchema;
  output_schema?: ToolJsonSchema;
  permission: ToolPermission;
  timeout_ms?: number;
  audit: ToolAuditMetadata;
  metadata?: ToolEnvelopeMetadata;
};

export function assistantToolRuntimePolicy(tool: Pick<AssistantTool, "metadata" | "permission">): PiRuntimeToolPolicy {
  const metadata = isRecord(tool.metadata?.xuanwu_runtime) ? tool.metadata.xuanwu_runtime : {};
  const profiles = Array.isArray(metadata.profiles)
    ? metadata.profiles.filter((value): value is PiRuntimeToolProfile => (
      typeof value === "string" && (PI_RUNTIME_TOOL_PROFILES as readonly string[]).includes(value)
    ))
    : [];
  return {
    aliases: stringList(metadata.aliases),
    family: cleanString(metadata.family) || "uncategorized",
    profiles: [...new Set(profiles)],
    risk_level: riskLevel(metadata.risk_level, tool.permission)
  };
}

export type ToolInvocation = {
  id: string;
  tool_name: string;
  provider_id: string;
  input: ToolEnvelopeMetadata;
  permission: ToolPermission;
  timeout_ms?: number;
  requested_at?: string;
  audit?: ToolAuditMetadata;
  metadata?: ToolEnvelopeMetadata;
};

export type ToolResult = {
  invocation_id: string;
  status: ToolResultStatus;
  output?: unknown;
  error?: ToolResultError;
  started_at?: string;
  ended_at?: string;
  duration_ms?: number;
  audit?: ToolAuditMetadata;
  metadata?: ToolEnvelopeMetadata;
};

export type ToolResultError = {
  code?: string;
  message: string;
  details?: unknown;
};

export type ToolEnvelopeValidationIssue = { path: string; message: string };

export function isToolProviderKind(value: unknown): value is ToolProviderKind {
  return typeof value === "string" && (TOOL_PROVIDER_KINDS as readonly string[]).includes(value);
}

export function isToolPermission(value: unknown): value is ToolPermission {
  return typeof value === "string" && (TOOL_PERMISSIONS as readonly string[]).includes(value);
}

export function isToolResultStatus(value: unknown): value is ToolResultStatus {
  return typeof value === "string" && (TOOL_RESULT_STATUSES as readonly string[]).includes(value);
}

export function assistantToolKey(tool: Pick<AssistantTool, "provider_id" | "name">): string {
  return `${tool.provider_id}:${tool.name}`;
}

export function validateToolProvider(provider: unknown): ToolEnvelopeValidationIssue[] {
  if (!isRecord(provider)) return [{ path: "provider", message: "provider must be an object" }];
  const issues: ToolEnvelopeValidationIssue[] = [];
  requireNonEmptyString(issues, provider.id, "id");
  requireNonEmptyString(issues, provider.name, "name");
  if (!isToolProviderKind(provider.kind)) issues.push({ path: "kind", message: "kind must be a supported provider kind" });
  if (provider.default_timeout_ms !== undefined) requirePositiveInteger(issues, provider.default_timeout_ms, "default_timeout_ms");
  if (provider.audit !== undefined) issues.push(...validateAuditMetadata(provider.audit, "audit"));
  return issues;
}

export function validateAssistantTool(tool: unknown): ToolEnvelopeValidationIssue[] {
  if (!isRecord(tool)) return [{ path: "tool", message: "tool must be an object" }];
  const issues: ToolEnvelopeValidationIssue[] = [];
  requireNonEmptyString(issues, tool.name, "name");
  requireNonEmptyString(issues, tool.provider_id, "provider_id");
  requireNonEmptyString(issues, tool.description, "description");
  if (!isRecord(tool.input_schema)) issues.push({ path: "input_schema", message: "input_schema must be an object" });
  if (tool.output_schema !== undefined && !isRecord(tool.output_schema)) {
    issues.push({ path: "output_schema", message: "output_schema must be an object" });
  }
  if (!isToolPermission(tool.permission)) issues.push({ path: "permission", message: "permission must be read, write, or dangerous" });
  if (tool.timeout_ms !== undefined) requirePositiveInteger(issues, tool.timeout_ms, "timeout_ms");
  issues.push(...validateAuditMetadata(tool.audit, "audit"));
  if (isRecord(tool.metadata) && tool.metadata.xuanwu_runtime !== undefined) {
    issues.push(...validateRuntimeToolPolicy(tool.metadata.xuanwu_runtime));
  }
  return issues;
}

export function validateToolInvocation(invocation: unknown): ToolEnvelopeValidationIssue[] {
  if (!isRecord(invocation)) return [{ path: "invocation", message: "invocation must be an object" }];
  const issues: ToolEnvelopeValidationIssue[] = [];
  requireNonEmptyString(issues, invocation.id, "id");
  requireNonEmptyString(issues, invocation.tool_name, "tool_name");
  requireNonEmptyString(issues, invocation.provider_id, "provider_id");
  if (!isRecord(invocation.input)) issues.push({ path: "input", message: "input must be an object" });
  if (!isToolPermission(invocation.permission)) issues.push({ path: "permission", message: "permission must be read, write, or dangerous" });
  if (invocation.timeout_ms !== undefined) requirePositiveInteger(issues, invocation.timeout_ms, "timeout_ms");
  if (invocation.audit !== undefined) issues.push(...validateAuditMetadata(invocation.audit, "audit"));
  return issues;
}

export function validateToolResult(result: unknown): ToolEnvelopeValidationIssue[] {
  if (!isRecord(result)) return [{ path: "result", message: "result must be an object" }];
  const issues: ToolEnvelopeValidationIssue[] = [];
  requireNonEmptyString(issues, result.invocation_id, "invocation_id");
  if (!isToolResultStatus(result.status)) issues.push({ path: "status", message: "status must be a supported result status" });
  if (result.duration_ms !== undefined) requireNonNegativeInteger(issues, result.duration_ms, "duration_ms");
  if (result.error !== undefined) issues.push(...validateResultError(result.error, "error"));
  return issues;
}

function validateAuditMetadata(value: unknown, path: string): ToolEnvelopeValidationIssue[] {
  if (!isRecord(value)) return [{ path, message: "audit metadata must be an object" }];
  if (!Array.isArray(value.redact) || value.redact.some((item) => typeof item !== "string")) {
    return [{ path: `${path}.redact`, message: "redact must be a string array" }];
  }
  return [];
}

function validateRuntimeToolPolicy(value: unknown): ToolEnvelopeValidationIssue[] {
  const path = "metadata.xuanwu_runtime";
  if (!isRecord(value)) return [{ path, message: "runtime tool policy must be an object" }];
  const issues: ToolEnvelopeValidationIssue[] = [];
  requireNonEmptyString(issues, value.family, `${path}.family`);
  if (!Array.isArray(value.aliases) || value.aliases.some((alias) => typeof alias !== "string" || alias.trim() === "")) {
    issues.push({ path: `${path}.aliases`, message: "aliases must be an array of non-empty strings" });
  }
  if (!Array.isArray(value.profiles) || value.profiles.some((profile) => (
    typeof profile !== "string" || !(PI_RUNTIME_TOOL_PROFILES as readonly string[]).includes(profile)
  ))) {
    issues.push({ path: `${path}.profiles`, message: "profiles must contain only supported runtime profiles" });
  }
  if (value.risk_level !== "low" && value.risk_level !== "medium" && value.risk_level !== "high") {
    issues.push({ path: `${path}.risk_level`, message: "risk_level must be low, medium, or high" });
  }
  return issues;
}

function validateResultError(value: unknown, path: string): ToolEnvelopeValidationIssue[] {
  if (!isRecord(value)) return [{ path, message: "error must be an object" }];
  const issues: ToolEnvelopeValidationIssue[] = [];
  requireNonEmptyString(issues, value.message, `${path}.message`);
  if (value.code !== undefined && typeof value.code !== "string") issues.push({ path: `${path}.code`, message: "code must be a string" });
  return issues;
}

function requireNonEmptyString(issues: ToolEnvelopeValidationIssue[], value: unknown, path: string): void {
  if (typeof value !== "string" || value.trim() === "") issues.push({ path, message: "must be a non-empty string" });
}

function requirePositiveInteger(issues: ToolEnvelopeValidationIssue[], value: unknown, path: string): void {
  if (!Number.isInteger(value) || Number(value) <= 0) issues.push({ path, message: "must be a positive integer" });
}

function requireNonNegativeInteger(issues: ToolEnvelopeValidationIssue[], value: unknown, path: string): void {
  if (!Number.isInteger(value) || Number(value) < 0) issues.push({ path, message: "must be a non-negative integer" });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(cleanString).filter(Boolean))];
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function riskLevel(value: unknown, permission: ToolPermission): PiRuntimeToolPolicy["risk_level"] {
  if (value === "low" || value === "medium" || value === "high") return value;
  if (permission === "read") return "low";
  if (permission === "dangerous") return "high";
  return "medium";
}
