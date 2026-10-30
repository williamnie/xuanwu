import type { RunnerDatabase } from "../db/database.ts";

export type McpRiskLevel = "low" | "medium" | "high";

export type McpCapabilityKind = "resource" | "tool";

export type McpPermission = "read" | "write" | "admin";

export type McpCapability = {
  allowed_actions: string[];
  description: string;
  id: string;
  input_schema?: Record<string, unknown>;
  kind: McpCapabilityKind;
  metadata: Record<string, unknown>;
  name: string;
  output_schema?: Record<string, unknown>;
  permission: McpPermission;
  read_only: boolean;
  requires_confirmation: boolean;
  risk_level: McpRiskLevel;
  server_id: string;
  source_path?: string;
  timeout_ms?: number;
  uri?: string;
};

export type McpServerTransport = {
  args: string[];
  command: string;
  type: "stdio";
  cwd?: string;
  env?: Record<string, string>;
};

export type McpServerRegistry = {
  approval_mode: "dangerous_only" | "every_write" | "read_only";
  capabilities: McpCapability[];
  description: string;
  diagnostics: McpRegistryDiagnostic[];
  id: string;
  metadata: Record<string, unknown>;
  name: string;
  permissions: McpPermission[];
  readiness: string;
  resources: McpCapability[];
  risk_level: McpRiskLevel;
  status: string;
  tools: McpCapability[];
  transport?: McpServerTransport;
  version?: string;
};

export type McpRegistryDiagnostic = {
  code: "registry_file_unavailable" | "registry_json_invalid" | "server_not_ready" | "server_unavailable" | string;
  message: string;
  readiness?: string;
  server_id: string;
  severity: "warning";
  source_path: string;
  status?: string;
};

export type McpRegistry = { diagnostics: McpRegistryDiagnostic[]; servers: McpServerRegistry[] };

export type McpRecommendationInput = { description?: string; issue?: unknown; title?: string };

export type McpRequirementRecommendation = McpCapability & { reason: string; score: number };

export type McpRegistryOptions = { database?: RunnerDatabase; registryJson?: string };

export type RawServer = Record<string, unknown>;

export type RawCapability = Record<string, unknown>;

export const MAX_SERVERS = 80;

export const MAX_CAPABILITIES_PER_SERVER = 160;

export const DEFAULT_REGISTRY = "{}";
