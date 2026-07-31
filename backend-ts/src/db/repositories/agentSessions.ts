import { normalizeAgentSessionRole } from "../../agents/roles.ts";
import type { RunnerDatabase } from "../database.ts";
import { issueTimestamp } from "./issueCreate.ts";

export type AgentSession = {
  agent_role: string; created_at: string; issue_id: number; preview: string;
  project_id: string; provider: string; provider_session_id: string;
  raw_ref: string; session_key: string; status: string; title: string; updated_at: string;
};
export type AgentSessionInput = Partial<Omit<AgentSession, "created_at" | "raw_ref" | "session_key" | "updated_at">> & {
  provider: string; provider_session_id: string; raw_ref?: unknown;
};
export type AgentSessionFilter = { limit?: number; projectId?: string; provider?: string; role?: string };

type AgentSessionRow = Record<keyof AgentSession, unknown>;
const SESSION_COLUMNS = `session_key, provider, provider_session_id, agent_role,
  project_id, issue_id, title, preview, status, raw_ref, created_at, updated_at`;

export function upsertAgentSession(db: RunnerDatabase, input: AgentSessionInput): AgentSession {
  const session = normalizeSessionInput(input);
  const timestamp = issueTimestamp();
  db.sqlite.run(`insert into agent_sessions (${SESSION_COLUMNS})
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    on conflict(session_key) do update set
      agent_role=coalesce(nullif(excluded.agent_role, ''), agent_sessions.agent_role),
      project_id=coalesce(nullif(excluded.project_id, ''), agent_sessions.project_id),
      issue_id=case when excluded.issue_id > 0 then excluded.issue_id else agent_sessions.issue_id end,
      title=coalesce(nullif(excluded.title, ''), agent_sessions.title),
      preview=coalesce(nullif(excluded.preview, ''), agent_sessions.preview),
      status=coalesce(nullif(excluded.status, ''), agent_sessions.status),
      raw_ref=case when excluded.raw_ref <> '{}' then excluded.raw_ref else agent_sessions.raw_ref end,
      updated_at=excluded.updated_at`,
    [session.session_key, session.provider, session.provider_session_id, session.agent_role,
      session.project_id, session.issue_id, session.title, session.preview, session.status,
      session.raw_ref, timestamp, timestamp]);
  return mustGetAgentSession(db, session.session_key);
}

export function listAgentSessions(db: RunnerDatabase, filter: AgentSessionFilter = {}): AgentSession[] {
  const query = buildSessionListQuery(filter);
  return db.sqlite.query<AgentSessionRow, string[]>(query.sql).all(...query.args).map(mapAgentSessionRow);
}

export function getAgentSession(db: RunnerDatabase, sessionKey: string): AgentSession | null {
  const key = cleanString(sessionKey);
  if (key === "") return null;
  const row = db.sqlite.query<AgentSessionRow, [string]>(
    `select ${SESSION_COLUMNS} from agent_sessions where session_key=?`
  ).get(key);
  return row ? mapAgentSessionRow(row) : null;
}

export function getAgentSessionByReference(db: RunnerDatabase, reference: string): AgentSession | null {
  const key = cleanString(reference);
  if (key === "") return null;
  const exact = getAgentSession(db, key);
  if (exact) return exact;
  const rows = db.sqlite.query<AgentSessionRow, [string]>(
    `select ${SESSION_COLUMNS} from agent_sessions
     where provider_session_id=? order by updated_at desc, session_key asc limit 2`
  ).all(key);
  return rows.length === 1 ? mapAgentSessionRow(rows[0]) : null;
}

function normalizeSessionInput(input: AgentSessionInput): AgentSession {
  const provider = cleanString(input.provider) || "codex";
  const providerSessionID = cleanString(input.provider_session_id);
  if (providerSessionID === "") throw new Error("provider_session_id is required");
  return {
    session_key: `${provider}:${providerSessionID}`, provider, provider_session_id: providerSessionID,
    agent_role: normalizeAgentSessionRole(input.agent_role), project_id: cleanString(input.project_id),
    issue_id: positiveOrZero(input.issue_id), title: cleanString(input.title),
    preview: cleanString(input.preview), status: cleanString(input.status),
    raw_ref: JSON.stringify(input.raw_ref ?? {}), created_at: "", updated_at: ""
  };
}

function buildSessionListQuery(filter: AgentSessionFilter): { args: string[]; sql: string } {
  const conditions: string[] = [];
  const args: string[] = [];
  addFilter(conditions, args, "provider=?", filter.provider);
  addFilter(conditions, args, "project_id=?", filter.projectId);
  addFilter(conditions, args, "agent_role=?", normalizeAgentSessionRole(filter.role));
  const where = conditions.length > 0 ? ` where ${conditions.join(" and ")}` : "";
  const limit = normalizedLimit(filter.limit);
  return {
    args,
    sql: `select ${SESSION_COLUMNS} from agent_sessions${where} order by updated_at desc, session_key asc${limit > 0 ? ` limit ${limit}` : ""}`
  };
}

function addFilter(conditions: string[], args: string[], condition: string, value: string | undefined): void {
  const text = cleanString(value);
  if (text === "") return;
  conditions.push(condition);
  args.push(text);
}

function normalizedLimit(value: number | undefined): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? Math.min(value, 10_000) : 0;
}

function mustGetAgentSession(db: RunnerDatabase, sessionKey: string): AgentSession {
  const session = getAgentSession(db, sessionKey);
  if (!session) throw new Error("agent session missing after write");
  return session;
}

function mapAgentSessionRow(row: AgentSessionRow): AgentSession {
  return {
    session_key: requiredString(row.session_key, "agent_sessions.session_key"),
    provider: requiredString(row.provider, "agent_sessions.provider"),
    provider_session_id: requiredString(row.provider_session_id, "agent_sessions.provider_session_id"),
    agent_role: optionalString(row.agent_role), project_id: optionalString(row.project_id),
    issue_id: integerValue(row.issue_id, "agent_sessions.issue_id"), title: optionalString(row.title),
    preview: optionalString(row.preview), status: optionalString(row.status), raw_ref: optionalString(row.raw_ref),
    created_at: requiredString(row.created_at, "agent_sessions.created_at"),
    updated_at: requiredString(row.updated_at, "agent_sessions.updated_at")
  };
}

function cleanString(value: unknown): string { return typeof value === "string" ? value.trim() : ""; }
function positiveOrZero(value: unknown): number { return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : 0; }
function optionalString(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value !== "string") throw new Error("expected string row value");
  return value.trim();
}
function requiredString(value: unknown, label: string): string {
  const text = optionalString(value);
  if (text === "") throw new Error(`${label} is required`);
  return text;
}
function integerValue(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) throw new Error(`${label} must be an integer`);
  return value;
}
