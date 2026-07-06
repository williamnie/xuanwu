import type { RunnerDatabase } from "../database.ts";
import {
  validateAssistantTool,
  validateToolProvider,
  type AssistantTool,
  type ToolAuditMetadata,
  type ToolEnvelopeMetadata,
  type ToolJsonSchema,
  type ToolPermission,
  type ToolProvider,
  type ToolProviderKind
} from "../../pi/toolProviderEnvelope.ts";

type ProviderRow = {
  audit_json: string;
  created_at: string;
  default_timeout_ms: number;
  description: string;
  id: string;
  kind: ToolProviderKind;
  metadata_json: string;
  name: string;
  status: "enabled" | "disabled" | "degraded";
  updated_at: string;
  version: string;
};

type ToolRow = {
  audit_json: string;
  created_at: string;
  description: string;
  input_schema_json: string;
  metadata_json: string;
  name: string;
  output_schema_json: string;
  permission: ToolPermission;
  provider_id: string;
  timeout_ms: number;
  updated_at: string;
};

export type StoredToolProvider = ToolProvider & { created_at: string; updated_at: string };
export type StoredAssistantTool = AssistantTool & { created_at: string; updated_at: string };

export function listStoredToolProviders(db: RunnerDatabase): StoredToolProvider[] {
  return db.sqlite.query<ProviderRow, []>(
    "select * from assistant_tool_providers order by id asc"
  ).all().map(providerFromRow);
}

export function listStoredAssistantTools(db: RunnerDatabase): StoredAssistantTool[] {
  return db.sqlite.query<ToolRow, []>(
    "select * from assistant_tools order by provider_id asc, name asc"
  ).all().map(toolFromRow);
}

export function getStoredAssistantTool(
  db: RunnerDatabase,
  providerID: string,
  name: string
): StoredAssistantTool | null {
  const row = db.sqlite.query<ToolRow, [string, string]>(
    "select * from assistant_tools where provider_id=? and name=?"
  ).get(providerID, name);
  return row ? toolFromRow(row) : null;
}

export function upsertToolProvider(db: RunnerDatabase, input: ToolProvider): StoredToolProvider {
  const provider = normalizedProvider(input);
  assertValidProvider(provider);
  const now = new Date().toISOString();
  db.sqlite.run(
    `insert into assistant_tool_providers
      (id, kind, name, description, status, version, default_timeout_ms, audit_json, metadata_json, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     on conflict(id) do update set
      kind=excluded.kind, name=excluded.name, description=excluded.description,
      status=excluded.status, version=excluded.version,
      default_timeout_ms=excluded.default_timeout_ms, audit_json=excluded.audit_json,
      metadata_json=excluded.metadata_json, updated_at=excluded.updated_at`,
    providerValues(provider, now)
  );
  return listStoredToolProviders(db).find((item) => item.id === provider.id)!;
}

export function upsertAssistantTool(db: RunnerDatabase, input: AssistantTool): StoredAssistantTool {
  const tool = normalizedTool(input);
  assertValidTool(tool);
  const now = new Date().toISOString();
  db.sqlite.run(
    `insert into assistant_tools
      (provider_id, name, description, input_schema_json, output_schema_json, permission, timeout_ms, audit_json, metadata_json, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     on conflict(provider_id, name) do update set
      description=excluded.description, input_schema_json=excluded.input_schema_json,
      output_schema_json=excluded.output_schema_json, permission=excluded.permission,
      timeout_ms=excluded.timeout_ms, audit_json=excluded.audit_json,
      metadata_json=excluded.metadata_json, updated_at=excluded.updated_at`,
    toolValues(tool, now)
  );
  return getStoredAssistantTool(db, tool.provider_id, tool.name)!;
}

function providerFromRow(row: ProviderRow): StoredToolProvider {
  return {
    audit: jsonValue<ToolAuditMetadata>(row.audit_json, { redact: [] }),
    created_at: row.created_at,
    default_timeout_ms: row.default_timeout_ms || undefined,
    description: row.description,
    id: row.id,
    kind: row.kind,
    metadata: jsonValue<ToolEnvelopeMetadata>(row.metadata_json, {}),
    name: row.name,
    status: row.status,
    updated_at: row.updated_at,
    version: row.version || undefined
  };
}

function toolFromRow(row: ToolRow): StoredAssistantTool {
  return {
    audit: jsonValue<ToolAuditMetadata>(row.audit_json, { redact: [] }),
    created_at: row.created_at,
    description: row.description,
    input_schema: jsonValue<ToolJsonSchema>(row.input_schema_json, {}),
    metadata: jsonValue<ToolEnvelopeMetadata>(row.metadata_json, {}),
    name: row.name,
    output_schema: optionalJsonSchema(row.output_schema_json),
    permission: row.permission,
    provider_id: row.provider_id,
    timeout_ms: row.timeout_ms || undefined,
    updated_at: row.updated_at
  };
}

function normalizedProvider(input: ToolProvider): ToolProvider {
  return { ...input, audit: input.audit ?? { redact: [] }, metadata: input.metadata ?? {} };
}

function normalizedTool(input: AssistantTool): AssistantTool {
  return { ...input, audit: input.audit ?? { redact: [] }, metadata: input.metadata ?? {} };
}

function assertValidProvider(provider: ToolProvider): void {
  const issues = validateToolProvider(provider);
  if (issues.length > 0) throw new Error(issues.map((issue) => `${issue.path}: ${issue.message}`).join("; "));
}

function assertValidTool(tool: AssistantTool): void {
  const issues = validateAssistantTool(tool);
  if (issues.length > 0) throw new Error(issues.map((issue) => `${issue.path}: ${issue.message}`).join("; "));
}

function providerValues(provider: ToolProvider, now: string): unknown[] {
  return [
    provider.id,
    provider.kind,
    provider.name,
    provider.description ?? "",
    provider.status ?? "enabled",
    provider.version ?? "",
    provider.default_timeout_ms ?? 0,
    JSON.stringify(provider.audit ?? { redact: [] }),
    JSON.stringify(provider.metadata ?? {}),
    now,
    now
  ];
}

function toolValues(tool: AssistantTool, now: string): unknown[] {
  return [
    tool.provider_id,
    tool.name,
    tool.description,
    JSON.stringify(tool.input_schema ?? {}),
    JSON.stringify(tool.output_schema ?? {}),
    tool.permission,
    tool.timeout_ms ?? 0,
    JSON.stringify(tool.audit ?? { redact: [] }),
    JSON.stringify(tool.metadata ?? {}),
    now,
    now
  ];
}

function optionalJsonSchema(raw: string): ToolJsonSchema | undefined {
  const value = jsonValue<ToolJsonSchema>(raw, {});
  return Object.keys(value).length === 0 ? undefined : value;
}

function jsonValue<T>(raw: string, fallback: T): T {
  try {
    const value = JSON.parse(raw);
    return value && typeof value === "object" ? value as T : fallback;
  } catch {
    return fallback;
  }
}
