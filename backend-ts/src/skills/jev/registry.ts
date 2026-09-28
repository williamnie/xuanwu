import { join } from "node:path";
import type { RunnerDatabase } from "../../db/database.ts";
import type { McpServerRegistry } from "../../mcp/registry.ts";
import { JEV_CAPABILITY_ID, JEV_SKILL_ID, JEV_TOOL_NAME, jevCredentialStatus, jevPackage, readJevConfig, type JevSkillConfig } from "./config.ts";

export const JEV_INPUT_SCHEMA = { type: "object", additionalProperties: false, required: ["title", "body"], properties: {
  title: { type: "string", maxLength: 500 }, body: { type: "string", maxLength: 12000 }, latest_message: { type: "string", maxLength: 4000 }
} };

export function optionalJevMcpServers(db: RunnerDatabase): McpServerRegistry[] {
  const { config, diagnostic } = readJevConfig(db);
  if (diagnostic || !config.enabled || !jevCredentialStatus(db, config).configured) return [];
  const server = jevMcpServer(config);
  return server ? [server] : [];
}

export function jevMcpServer(config: JevSkillConfig): McpServerRegistry | null {
  const pkg = jevPackage();
  if (!pkg.installed || pkg.diagnostic) return null;
  const tool = { id: JEV_CAPABILITY_ID, name: JEV_TOOL_NAME, server_id: JEV_SKILL_ID, kind: "tool" as const,
    description: "Use the optional jev-assist skill for a bounded report's intent, information completeness and message kind; never required to continue a task.",
    input_schema: JEV_INPUT_SCHEMA, permission: "read" as const, read_only: true, requires_confirmation: false,
    risk_level: "low" as const, allowed_actions: [], timeout_ms: config.timeoutMs + 1500,
    metadata: { optional_skill: JEV_SKILL_ID, xuanwu_runtime: { family: "optional_skills", profiles: ["chat", "review", "manager_cycle", "recovery", "acceptance"], aliases: ["Jev", "报告分类", "信息完整性"], risk_level: "low" } } };
  return { id: JEV_SKILL_ID, name: "Jev", description: tool.description, approval_mode: "read_only", permissions: ["read"],
    readiness: "ready", status: "enabled", risk_level: "low", diagnostics: [], metadata: { optional_skill: JEV_SKILL_ID },
    tools: [tool], capabilities: [tool], resources: [], version: "1.0.0",
    transport: { type: "stdio", command: pkg.command, args: [join(pkg.directory, "scripts", "server.mjs")] } };
}
