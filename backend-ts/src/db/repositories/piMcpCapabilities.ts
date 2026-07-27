import type { RunnerDatabase } from "../database.ts";
import { normalizeID } from "./piMcpServers.ts";

export type PiMcpCapabilityInput = {
  description?: string;
  diagnostics?: unknown[];
  enabled?: boolean;
  id?: string;
  input_schema?: Record<string, unknown>;
  kind: "resource" | "tool";
  metadata?: Record<string, unknown>;
  name: string;
  output_schema?: Record<string, unknown>;
  permission?: "read" | "write" | "admin";
  read_only?: boolean;
  requires_confirmation?: boolean;
  risk_level?: "low" | "medium" | "high";
  server_id: string;
  source_path?: string;
  timeout_ms?: number;
  uri?: string;
};
export type PiMcpCapabilityPatch = Partial<Pick<PiMcpCapabilityInput,
  "enabled" | "permission" | "read_only" | "requires_confirmation" | "risk_level" | "timeout_ms"
>>;
export type PiMcpCapability = Required<Omit<PiMcpCapabilityInput,
  "diagnostics" | "enabled" | "input_schema" | "metadata" | "output_schema" | "read_only" | "requires_confirmation" | "timeout_ms"
>> & {
  diagnostics: unknown[];
  enabled: boolean;
  input_schema: Record<string, unknown>;
  metadata: Record<string, unknown>;
  output_schema: Record<string, unknown>;
  read_only: boolean;
  requires_confirmation: boolean;
  timeout_ms: number;
  created_at: string;
  updated_at: string;
};

type CapabilityRow = {
  created_at: string; description: string; diagnostics_json: string; enabled: number; id: string;
  input_schema_json: string; kind: "resource" | "tool"; metadata_json: string; name: string;
  output_schema_json: string; permission: "read" | "write" | "admin"; read_only: number;
  requires_confirmation: number; risk_level: "low" | "medium" | "high"; server_id: string;
  source_path: string; timeout_ms: number; updated_at: string; uri: string;
};

export function listPiMcpCapabilities(db: RunnerDatabase, serverID = ""): PiMcpCapability[] {
  const sql = serverID ? "select * from pi_mcp_capabilities where server_id=? order by kind, name" : "select * from pi_mcp_capabilities order by server_id, kind, name";
  const rows = serverID ? db.sqlite.query<CapabilityRow, [string]>(sql).all(serverID) : db.sqlite.query<CapabilityRow, []>(sql).all();
  return rows.map(capabilityFromRow);
}

export function getPiMcpCapability(db: RunnerDatabase, id: string): PiMcpCapability | null {
  const row = db.sqlite.query<CapabilityRow, [string]>("select * from pi_mcp_capabilities where id=?").get(id);
  return row ? capabilityFromRow(row) : null;
}

export function replacePiMcpCapabilitiesForServer(db: RunnerDatabase, serverID: string, inputs: PiMcpCapabilityInput[]): PiMcpCapability[] {
  const wanted = new Set(inputs.map((item) => capabilityID(item)));
  const existing = new Map(listPiMcpCapabilities(db, serverID).map((item) => [item.id, item]));
  const write = db.transaction((items: PiMcpCapabilityInput[]) => {
    for (const input of items) upsertPiMcpCapability(db, { ...input, enabled: existing.get(capabilityID(input))?.enabled ?? input.enabled });
    for (const item of existing.values()) if (!wanted.has(item.id)) db.sqlite.run("delete from pi_mcp_capabilities where id=?", [item.id]);
  });
  write(inputs);
  return listPiMcpCapabilities(db, serverID);
}

export function upsertPiMcpCapability(db: RunnerDatabase, input: PiMcpCapabilityInput): PiMcpCapability {
  const existing = input.id ? getPiMcpCapability(db, input.id) : null;
  const record = normalized(input, existing ?? undefined);
  const now = new Date().toISOString();
  db.sqlite.run(
    `insert into pi_mcp_capabilities
      (id, server_id, kind, name, description, uri, input_schema_json, output_schema_json, permission,
       risk_level, requires_confirmation, read_only, enabled, timeout_ms, source_path, diagnostics_json,
       metadata_json, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     on conflict(id) do update set
      kind=excluded.kind, name=excluded.name, description=excluded.description, uri=excluded.uri,
      input_schema_json=excluded.input_schema_json, output_schema_json=excluded.output_schema_json,
      permission=excluded.permission, risk_level=excluded.risk_level, requires_confirmation=excluded.requires_confirmation,
      read_only=excluded.read_only, enabled=excluded.enabled, timeout_ms=excluded.timeout_ms,
      source_path=excluded.source_path, diagnostics_json=excluded.diagnostics_json,
      metadata_json=excluded.metadata_json, updated_at=excluded.updated_at`,
    values(record, now)
  );
  return getPiMcpCapability(db, record.id)!;
}

export function patchPiMcpCapability(db: RunnerDatabase, id: string, patch: PiMcpCapabilityPatch): PiMcpCapability | null {
  const existing = getPiMcpCapability(db, id);
  if (!existing) return null;
  return upsertPiMcpCapability(db, { ...existing, ...patch, id });
}

function normalized(input: PiMcpCapabilityInput, existing?: PiMcpCapability): PiMcpCapabilityInput & { id: string } {
  const permission = input.permission ?? existing?.permission ?? (input.kind === "resource" ? "read" : "write");
  const risk = input.risk_level ?? existing?.risk_level ?? (permission === "read" ? "low" : permission === "admin" ? "high" : "medium");
  const readOnly = input.read_only ?? existing?.read_only ?? (permission === "read" && risk === "low");
  return { description: clean(input.description ?? existing?.description), diagnostics: input.diagnostics ?? existing?.diagnostics ?? [],
    enabled: input.enabled ?? existing?.enabled ?? false, id: input.id || capabilityID(input), input_schema: input.input_schema ?? existing?.input_schema ?? {},
    kind: input.kind, metadata: input.metadata ?? existing?.metadata ?? {}, name: normalizeName(input.name),
    output_schema: input.output_schema ?? existing?.output_schema ?? {}, permission, read_only: readOnly,
    requires_confirmation: input.requires_confirmation ?? existing?.requires_confirmation ?? (risk === "high" || permission === "admin"),
    risk_level: risk, server_id: input.server_id, source_path: clean(input.source_path ?? existing?.source_path),
    timeout_ms: positive(input.timeout_ms ?? existing?.timeout_ms) || 10000, uri: clean(input.uri ?? existing?.uri) };
}

function capabilityID(input: Pick<PiMcpCapabilityInput, "kind" | "name" | "server_id">): string {
  return `${input.server_id}:${input.kind}:${normalizeName(input.name)}`;
}

function values(input: PiMcpCapabilityInput & { id: string }, now: string): any[] {
  return [input.id, input.server_id, input.kind, input.name, input.description ?? "", input.uri ?? "",
    JSON.stringify(input.input_schema ?? {}), JSON.stringify(input.output_schema ?? {}), input.permission ?? "read",
    input.risk_level ?? "low", input.requires_confirmation ? 1 : 0, input.read_only ? 1 : 0,
    input.enabled ? 1 : 0, input.timeout_ms ?? 10000, input.source_path ?? "",
    JSON.stringify(input.diagnostics ?? []), JSON.stringify(input.metadata ?? {}), now, now];
}

function capabilityFromRow(row: CapabilityRow): PiMcpCapability {
  return { created_at: row.created_at, description: row.description, diagnostics: json(row.diagnostics_json, []),
    enabled: row.enabled === 1, id: row.id, input_schema: json(row.input_schema_json, {}), kind: row.kind,
    metadata: json(row.metadata_json, {}), name: row.name, output_schema: json(row.output_schema_json, {}),
    permission: row.permission, read_only: row.read_only === 1, requires_confirmation: row.requires_confirmation === 1,
    risk_level: row.risk_level, server_id: row.server_id, source_path: row.source_path,
    timeout_ms: row.timeout_ms || 10000, updated_at: row.updated_at, uri: row.uri };
}

function normalizeName(value: unknown): string {
  return normalizeID(value).replace(/:/g, "-");
}

function json<T>(raw: string, fallback: T): T {
  try { const value = JSON.parse(raw); return value && typeof value === "object" ? value as T : fallback; } catch { return fallback; }
}

function positive(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
}

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
