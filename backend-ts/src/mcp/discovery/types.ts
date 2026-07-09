export type McpDiscoveryTransport =
  | { args?: string[]; command: string; cwd?: string; env?: Record<string, string>; type: "stdio" }
  | { headers?: Record<string, string>; type: "http" | "sse" | "streamable_http"; url: string };

export type McpDiscoveryServer = {
  description?: string;
  diagnostics?: McpDiscoveryDiagnostic[];
  id: string;
  metadata?: Record<string, unknown>;
  name: string;
  risk_level?: "low" | "medium" | "high";
  source: string;
  source_path: string;
  transport: McpDiscoveryTransport;
};

export type McpDiscoveryDiagnostic = {
  code: string;
  message: string;
  severity: "info" | "warning" | "error";
  source?: string;
  source_path?: string;
};

export type McpDiscoveryOptions = {
  homeDir?: string;
  sources?: string[];
  workspaceDir?: string;
};

export type McpDiscoverySourceSummary = {
  description: string;
  id: string;
  paths: { exists: boolean; path: string }[];
};

export type McpDetector = {
  description: string;
  id: string;
  paths(options: Required<Pick<McpDiscoveryOptions, "homeDir" | "workspaceDir">>): string[];
  discover(options: Required<Pick<McpDiscoveryOptions, "homeDir" | "workspaceDir">>): Promise<{
    diagnostics: McpDiscoveryDiagnostic[];
    servers: McpDiscoveryServer[];
  }>;
};
