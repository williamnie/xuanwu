import type { RunnerDatabase } from "../database.ts";

export type PiMcpTransportType = "stdio" | "http" | "sse" | "streamable_http";
export const PI_MCP_APPROVAL_MODES = ["dangerous_only", "every_write", "read_only"] as const;
export type PiMcpApprovalMode = (typeof PI_MCP_APPROVAL_MODES)[number];
export type PiMcpServerInput = {
  approval_granted_at?: string;
  approval_mode?: PiMcpApprovalMode;
  args?: string[];
  command?: string;
  cwd?: string;
  description?: string;
  diagnostics?: unknown[];
  enabled?: boolean;
  env?: Record<string, string>;
  headers?: Record<string, string>;
  id?: string;
  last_introspected_at?: string;
  last_scan_at?: string;
  metadata?: Record<string, unknown>;
  name: string;
  readiness?: string;
  redaction?: Record<string, string[]>;
  risk_level?: string;
  source?: string;
  source_path?: string;
  status?: string;
  transport_type?: PiMcpTransportType;
  url?: string;
};
export type PiMcpServerPatch = Partial<Omit<PiMcpServerInput, "id" | "name">> & { name?: string };
export type PiMcpServer = Required<Omit<PiMcpServerInput,
  "diagnostics" | "enabled" | "env" | "headers" | "metadata" | "redaction"
>> & {
  diagnostics: unknown[];
  enabled: boolean;
  env: Record<string, string>;
  headers: Record<string, string>;
  metadata: Record<string, unknown>;
  redaction: Record<string, string[]>;
  created_at: string;
  updated_at: string;
};

type ServerRow = {
  approval_granted_at: string; approval_mode: PiMcpApprovalMode;
  args_json: string; command: string; created_at: string; cwd: string; description: string;
  diagnostics_json: string; enabled: number; env_json: string; headers_json: string; id: string;
  last_introspected_at: string; last_scan_at: string; metadata_json: string; name: string;
  readiness: string; redaction_json: string; risk_level: string; source: string; source_path: string;
  status: string; transport_type: PiMcpTransportType; updated_at: string; url: string;
};

export function listPiMcpServers(db: RunnerDatabase): PiMcpServer[] {
  return db.sqlite.query<ServerRow, []>("select * from pi_mcp_servers order by source asc, name asc").all().map(serverFromRow);
}

export function getPiMcpServer(db: RunnerDatabase, id: string): PiMcpServer | null {
  const row = db.sqlite.query<ServerRow, [string]>("select * from pi_mcp_servers where id=?").get(id);
  return row ? serverFromRow(row) : null;
}

export function upsertPiMcpServer(db: RunnerDatabase, input: PiMcpServerInput): PiMcpServer {
  const existing = input.id ? getPiMcpServer(db, input.id) : null;
  const record = normalizedServer(input, existing ?? undefined);
  const now = new Date().toISOString();
  db.sqlite.run(
    `insert into pi_mcp_servers
      (id, name, description, source, source_path, transport_type, command, args_json, cwd, env_json,
       url, headers_json, enabled, status, readiness, risk_level, diagnostics_json, redaction_json,
       metadata_json, last_scan_at, last_introspected_at, approval_mode, approval_granted_at, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     on conflict(id) do update set
      name=excluded.name, description=excluded.description, source=excluded.source, source_path=excluded.source_path,
      transport_type=excluded.transport_type, command=excluded.command, args_json=excluded.args_json, cwd=excluded.cwd,
      env_json=excluded.env_json, url=excluded.url, headers_json=excluded.headers_json, enabled=excluded.enabled,
      status=excluded.status, readiness=excluded.readiness, risk_level=excluded.risk_level,
      diagnostics_json=excluded.diagnostics_json, redaction_json=excluded.redaction_json,
      metadata_json=excluded.metadata_json, last_scan_at=excluded.last_scan_at,
      last_introspected_at=excluded.last_introspected_at, approval_mode=excluded.approval_mode,
      approval_granted_at=excluded.approval_granted_at, updated_at=excluded.updated_at`,
    serverValues(record, now)
  );
  return getPiMcpServer(db, record.id)!;
}

export function patchPiMcpServer(db: RunnerDatabase, id: string, patch: PiMcpServerPatch): PiMcpServer | null {
  const existing = getPiMcpServer(db, id);
  if (!existing) return null;
  return upsertPiMcpServer(db, { ...existing, ...patch, id });
}

export function deletePiMcpServer(db: RunnerDatabase, id: string): boolean {
  const before = db.sqlite.query<{ count: number }, [string]>("select count(*) as count from pi_mcp_servers where id=?").get(id)?.count ?? 0;
  db.sqlite.run("delete from pi_mcp_servers where id=?", [id]);
  return before > 0;
}

function normalizedServer(input: PiMcpServerInput, existing?: PiMcpServer): PiMcpServerInput & { id: string } {
  const id = normalizeID(input.id || input.name);
  const env = stringRecord(input.env ?? existing?.env ?? {});
  const headers = stringRecord(input.headers ?? existing?.headers ?? {});
  return {
    approval_granted_at: clean(input.approval_granted_at ?? existing?.approval_granted_at),
    approval_mode: approvalMode(input.approval_mode ?? existing?.approval_mode),
    args: stringList(input.args ?? existing?.args ?? []), command: clean(input.command ?? existing?.command),
    cwd: clean(input.cwd ?? existing?.cwd), description: clean(input.description ?? existing?.description),
    diagnostics: input.diagnostics ?? existing?.diagnostics ?? [], enabled: input.enabled ?? existing?.enabled ?? false,
    env, headers, id, last_introspected_at: clean(input.last_introspected_at ?? existing?.last_introspected_at),
    last_scan_at: clean(input.last_scan_at ?? existing?.last_scan_at), metadata: input.metadata ?? existing?.metadata ?? {},
    name: clean(input.name) || id, readiness: clean(input.readiness ?? existing?.readiness) || "not_introspected",
    redaction: input.redaction ?? existing?.redaction ?? redactionFor(env, headers),
    risk_level: clean(input.risk_level ?? existing?.risk_level) || "medium", source: clean(input.source ?? existing?.source) || "manual",
    source_path: clean(input.source_path ?? existing?.source_path), status: clean(input.status ?? existing?.status) || "discovered",
    transport_type: input.transport_type ?? existing?.transport_type ?? "stdio", url: clean(input.url ?? existing?.url)
  };
}

function serverValues(input: PiMcpServerInput & { id: string }, now: string): any[] {
  return [input.id, input.name, input.description ?? "", input.source ?? "manual", input.source_path ?? "",
    input.transport_type ?? "stdio", input.command ?? "", JSON.stringify(input.args ?? []), input.cwd ?? "",
    JSON.stringify(input.env ?? {}), input.url ?? "", JSON.stringify(input.headers ?? {}), input.enabled ? 1 : 0,
    input.status ?? "discovered", input.readiness ?? "not_introspected", input.risk_level ?? "medium",
    JSON.stringify(input.diagnostics ?? []), JSON.stringify(input.redaction ?? {}), JSON.stringify(input.metadata ?? {}),
    input.last_scan_at ?? "", input.last_introspected_at ?? "", input.approval_mode ?? "dangerous_only",
    input.approval_granted_at ?? "", now, now];
}

function serverFromRow(row: ServerRow): PiMcpServer {
  return { approval_granted_at: row.approval_granted_at, approval_mode: approvalMode(row.approval_mode),
    args: json(row.args_json, []), command: row.command, created_at: row.created_at, cwd: row.cwd,
    description: row.description, diagnostics: json(row.diagnostics_json, []), enabled: row.enabled === 1,
    env: json(row.env_json, {}), headers: json(row.headers_json, {}), id: row.id,
    last_introspected_at: row.last_introspected_at, last_scan_at: row.last_scan_at, metadata: json(row.metadata_json, {}),
    name: row.name, readiness: row.readiness, redaction: json(row.redaction_json, {}), risk_level: row.risk_level,
    source: row.source, source_path: row.source_path, status: row.status, transport_type: row.transport_type,
    updated_at: row.updated_at, url: row.url };
}

export function approvalMode(value: unknown): PiMcpApprovalMode {
  const mode = clean(value);
  return (PI_MCP_APPROVAL_MODES as readonly string[]).includes(mode)
    ? mode as PiMcpApprovalMode
    : "dangerous_only";
}

export function normalizeID(value: unknown): string {
  return clean(value).toLowerCase().replace(/[^a-z0-9_:-]+/g, "-").replace(/^-+|-+$/g, "");
}

export function redactionFor(env: Record<string, string>, headers: Record<string, string>): Record<string, string[]> {
  return { env: Object.keys(env), headers: Object.keys(headers).filter((key) => /auth|token|key|secret/i.test(key)) };
}

function json<T>(raw: string, fallback: T): T {
  try { const value = JSON.parse(raw); return value && typeof value === "object" ? value as T : fallback; } catch { return fallback; }
}

function stringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [clean(k), clean(v)]).filter(([k]) => k !== ""));
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.map(clean).filter((item) => item !== "") : [];
}

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
