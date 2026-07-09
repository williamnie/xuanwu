import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseCodexTomlMcpServers, parseJsonMcpServers } from "./configParsers.ts";
import type { McpDetector, McpDiscoveryOptions, McpDiscoveryServer, McpDiscoverySourceSummary } from "./types.ts";

export function defaultMcpDiscoveryOptions(options: McpDiscoveryOptions = {}) {
  return {
    homeDir: options.homeDir || process.env.HOME || "",
    workspaceDir: options.workspaceDir || process.cwd()
  };
}

export function listMcpDiscoverySources(options: McpDiscoveryOptions = {}): McpDiscoverySourceSummary[] {
  const resolved = defaultMcpDiscoveryOptions(options);
  return detectors().map((detector) => ({
    description: detector.description,
    id: detector.id,
    paths: detector.paths(resolved).map((path) => ({ exists: existsSync(path), path }))
  }));
}

export async function scanMcpDiscoverySources(options: McpDiscoveryOptions = {}) {
  const resolved = defaultMcpDiscoveryOptions(options);
  const wanted = new Set(options.sources ?? detectors().map((item) => item.id));
  const selected = detectors().filter((detector) => wanted.has(detector.id));
  const results = await Promise.all(selected.map((detector) => detector.discover(resolved)));
  return {
    diagnostics: results.flatMap((item) => item.diagnostics),
    servers: dedupe(results.flatMap((item) => item.servers))
  };
}

function detectors(): McpDetector[] {
  return [codexDetector(), jsonDetector("claude", "Claude Desktop / Claude Code MCP configs", claudePaths),
    jsonDetector("cursor", "Cursor MCP configs", cursorPaths), jsonDetector("vscode", "VS Code MCP configs", vscodePaths),
    jsonDetector("kimi", "Kimi Code MCP configs", kimiPaths), jsonDetector("project", "Workspace MCP configs", projectPaths)];
}

function codexDetector(): McpDetector {
  return {
    description: "Codex local ~/.codex/config.toml mcp_servers.*",
    id: "codex",
    paths: ({ homeDir }) => [join(homeDir, ".codex", "config.toml")],
    discover: async (options) => readKnownFiles("codex", codexDetector().paths(options), parseCodexTomlMcpServers)
  };
}

function jsonDetector(id: string, description: string, pathBuilder: (home: string, workspace: string) => string[]): McpDetector {
  return {
    description,
    id,
    paths: ({ homeDir, workspaceDir }) => pathBuilder(homeDir, workspaceDir),
    discover: async (options) => readKnownFiles(id, pathBuilder(options.homeDir, options.workspaceDir),
      (text, path) => parseJsonMcpServers(text, id, path))
  };
}

function readKnownFiles(id: string, paths: string[], parse: (text: string, path: string) => McpDiscoveryServer[]) {
  const diagnostics = [];
  const servers = [];
  for (const path of paths) {
    if (!existsSync(path)) continue;
    try { servers.push(...parse(readFileSync(path, "utf8"), path)); }
    catch (error) { diagnostics.push({ code: "mcp_discovery_read_failed", message: safeMessage(error), severity: "warning" as const, source: id, source_path: path }); }
  }
  return { diagnostics, servers };
}

function claudePaths(home: string, workspace: string): string[] {
  return [join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json"),
    join(home, ".config", "Claude", "claude_desktop_config.json"), join(home, ".claude.json"),
    join(home, ".config", "claude-code", "mcp_servers.json"), join(workspace, ".claude", "mcp.json")];
}

function cursorPaths(home: string, workspace: string): string[] {
  return [join(home, ".cursor", "mcp.json"), join(workspace, ".cursor", "mcp.json")];
}

function vscodePaths(home: string, workspace: string): string[] {
  return [join(home, "Library", "Application Support", "Code", "User", "mcp.json"),
    join(home, ".config", "Code", "User", "mcp.json"), join(home, ".vscode", "mcp.json"),
    join(workspace, ".vscode", "mcp.json"), join(workspace, ".vscode", "settings.json")];
}

function kimiPaths(home: string, workspace: string): string[] {
  return [join(home, ".kimi", "mcp.json"), join(home, ".config", "kimi", "mcp.json"), join(workspace, ".kimi", "mcp.json")];
}

function projectPaths(_home: string, workspace: string): string[] {
  return [join(workspace, ".mcp.json"), join(workspace, "mcp.json")];
}

function dedupe<T extends { id: string }>(items: T[]): T[] {
  return [...new Map(items.map((item) => [item.id, item])).values()];
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message : "MCP discovery failed";
}
