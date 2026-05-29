import type { RunnerDatabase } from "../../database.ts";
import {
  cleanString,
  deleteByID,
  getByID,
  integerInput,
  integerValue,
  jsonText,
  listRows,
  now,
  optionalString,
  requiredString,
  requireCreateFields,
  updateByID,
  type PatchInput
} from "./common.ts";

export type PiAgent = {
  id: string; name: string; provider: string; model_provider: string; model_id: string;
  thinking_level: string; cwd_policy: string; tools_json: string; instructions: string;
  enabled: number; created_at: string; updated_at: string;
};

export type PiAgentInput = PatchInput<PiAgent>;

const TABLE = "pi_agents";
const COLUMNS = `id, name, provider, model_provider, model_id, thinking_level,
  cwd_policy, tools_json, instructions, enabled, created_at, updated_at`;
const UPDATE_COLUMNS = [
  "name", "provider", "model_provider", "model_id", "thinking_level",
  "cwd_policy", "tools_json", "instructions", "enabled"
] as const;

export function createPiAgent(db: RunnerDatabase, input: PiAgentInput): PiAgent {
  const record = normalizeCreate(input);
  requireCreateFields(record, ["id", "name"]);
  const timestamp = now();
  db.sqlite.run(`insert into ${TABLE} (${COLUMNS}) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [record.id, record.name, record.provider, record.model_provider, record.model_id,
      record.thinking_level, record.cwd_policy, record.tools_json, record.instructions,
      record.enabled, timestamp, timestamp]);
  return mustGetPiAgent(db, record.id);
}

export function updatePiAgent(db: RunnerDatabase, id: string, input: PiAgentInput): PiAgent {
  updateByID<PiAgent>(db, TABLE, UPDATE_COLUMNS, id, normalizePatch(input));
  return mustGetPiAgent(db, id);
}

export function listPiAgents(db: RunnerDatabase): PiAgent[] {
  return listRows(db, TABLE, COLUMNS, mapPiAgent, { args: [], sql: " order by created_at asc, id asc" });
}

export function getPiAgent(db: RunnerDatabase, id: string): PiAgent | null {
  return getByID(db, TABLE, COLUMNS, id, mapPiAgent);
}

export function deletePiAgent(db: RunnerDatabase, id: string): boolean {
  return deleteByID(db, TABLE, id);
}

function mustGetPiAgent(db: RunnerDatabase, id: string): PiAgent {
  const record = getPiAgent(db, id);
  if (!record) throw new Error("pi agent missing after write");
  return record;
}

function normalizeCreate(input: PiAgentInput): PiAgent {
  return {
    id: cleanString(input.id), name: cleanString(input.name),
    provider: cleanString(input.provider) || "pi-sdk",
    model_provider: cleanString(input.model_provider), model_id: cleanString(input.model_id),
    thinking_level: cleanString(input.thinking_level) || "medium",
    cwd_policy: cleanString(input.cwd_policy) || "project",
    tools_json: jsonText(input.tools_json, "[]"), instructions: cleanString(input.instructions),
    enabled: integerInput(input.enabled, 1), created_at: "", updated_at: ""
  };
}

function normalizePatch(input: PiAgentInput): PiAgentInput {
  return { ...input, tools_json: input.tools_json === undefined ? undefined : jsonText(input.tools_json, "[]") };
}

function mapPiAgent(row: Record<string, unknown>): PiAgent {
  return {
    id: requiredString(row.id, "pi_agents.id"), name: requiredString(row.name, "pi_agents.name"),
    provider: requiredString(row.provider, "pi_agents.provider"),
    model_provider: optionalString(row.model_provider), model_id: optionalString(row.model_id),
    thinking_level: requiredString(row.thinking_level, "pi_agents.thinking_level"),
    cwd_policy: requiredString(row.cwd_policy, "pi_agents.cwd_policy"),
    tools_json: optionalString(row.tools_json), instructions: optionalString(row.instructions),
    enabled: integerValue(row.enabled, "pi_agents.enabled"),
    created_at: requiredString(row.created_at, "pi_agents.created_at"),
    updated_at: requiredString(row.updated_at, "pi_agents.updated_at")
  };
}
