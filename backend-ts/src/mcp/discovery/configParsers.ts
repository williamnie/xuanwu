import { normalizeID } from "../../db/repositories/piMcpServers.ts";
import type { McpDiscoveryServer } from "./types.ts";

type RawServer = Record<string, unknown>;

export function parseJsonMcpServers(text: string, source: string, sourcePath: string): McpDiscoveryServer[] {
  const root = json(text);
  if (!isRecord(root)) return [];
  const maps = [root.mcpServers, root.mcp_servers, root.servers, record(root.mcp).servers].filter(Boolean);
  return maps.flatMap((value) => serversFromValue(value, source, sourcePath));
}

export function parseCodexTomlMcpServers(text: string, sourcePath: string): McpDiscoveryServer[] {
  const sections = new Map<string, RawServer>();
  let current = "";
  let envSection = "";
  for (const rawLine of text.split(/\r?\n/)) {
    const line = stripComment(rawLine).trim();
    if (!line) continue;
    const header = /^\[([^\]]+)]$/.exec(line)?.[1]?.trim() ?? "";
    if (header) {
      const match = /^mcp_servers\.([^\.]+)(?:\.(env))?$/.exec(header);
      current = match ? match[1] : "";
      envSection = match?.[2] === "env" ? current : "";
      if (current && !sections.has(current)) sections.set(current, { name: current });
      continue;
    }
    const keyValue = /^([A-Za-z0-9_-]+)\s*=\s*(.+)$/.exec(line);
    if (!keyValue || !current) continue;
    const [, key, rawValue] = keyValue;
    const target = sections.get(current)!;
    if (envSection) target.env = { ...record(target.env), [key]: parseString(rawValue) };
    else target[key] = parseTomlValue(rawValue);
  }
  return [...sections.entries()].map(([name, raw]) => serverFromRaw(name, raw, "codex", sourcePath)).filter(Boolean) as McpDiscoveryServer[];
}

function serversFromValue(value: unknown, source: string, sourcePath: string): McpDiscoveryServer[] {
  if (Array.isArray(value)) return value.map((item) => serverFromRaw(clean(record(item).name), record(item), source, sourcePath)).filter(Boolean) as McpDiscoveryServer[];
  if (!isRecord(value)) return [];
  return Object.entries(value).map(([name, raw]) => serverFromRaw(name, record(raw), source, sourcePath)).filter(Boolean) as McpDiscoveryServer[];
}

function serverFromRaw(name: string, raw: RawServer, source: string, sourcePath: string): McpDiscoveryServer | null {
  const id = normalizeID(`${source}-${clean(raw.id) || name}`);
  const command = clean(raw.command ?? raw.executable);
  const url = clean(raw.url ?? raw.endpoint);
  if (!id || (!command && !url)) return null;
  const transport = command ? {
    args: stringList(raw.args), command, cwd: clean(raw.cwd) || undefined,
    env: stringRecord(raw.env), type: "stdio" as const
  } : {
    headers: stringRecord(raw.headers), type: httpType(raw.transport ?? raw.type), url
  };
  return { description: clean(raw.description), id, name: clean(raw.name) || name, source, source_path: sourcePath, transport };
}

function httpType(value: unknown): "http" | "sse" | "streamable_http" {
  const text = clean(value).toLowerCase();
  if (text === "sse" || text === "streamable_http") return text;
  return "http";
}

function parseTomlValue(value: string): unknown {
  const trimmed = value.trim();
  if (trimmed.startsWith("[")) return parseArray(trimmed);
  if (trimmed.startsWith("{")) return parseInlineTable(trimmed);
  return parseString(trimmed);
}

function parseArray(value: string): string[] {
  return [...value.matchAll(/"((?:\\.|[^"])*)"/g)].map((match) => unescape(match[1]));
}

function parseInlineTable(value: string): Record<string, string> {
  const body = value.replace(/^\{/, "").replace(/}$/, "");
  return Object.fromEntries(body.split(",").map((part) => part.trim()).filter(Boolean).map((part) => {
    const [key, ...rest] = part.split("=");
    return [clean(key), parseString(rest.join("="))];
  }).filter(([key]) => key));
}

function parseString(value: string): string {
  const match = /^"((?:\\.|[^"])*)"$/.exec(value.trim());
  return match ? unescape(match[1]) : clean(value);
}

function stripComment(value: string): string {
  return value.replace(/\s+#.*$/, "");
}

function json(text: string): unknown {
  try { return JSON.parse(text) as unknown; } catch { return undefined; }
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.map(clean).filter(Boolean) : [];
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value).map(([key, child]) => [clean(key), clean(child)]).filter(([key]) => key);
  return entries.length ? Object.fromEntries(entries) : undefined;
}

function record(value: unknown): RawServer {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is RawServer {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function unescape(value: string): string {
  return value.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
}
