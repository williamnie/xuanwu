import type { RunnerDatabase } from "../../database.ts";
import { DEFAULT_PI_AGENT_ID } from "../../defaultPiAgent.ts";
import {
  getByID,
  integerValue,
  jsonText,
  optionalString,
  requiredString,
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

export function updatePiSupervisor(db: RunnerDatabase, input: PiAgentInput): PiAgent {
  updateByID<PiAgent>(db, TABLE, UPDATE_COLUMNS, DEFAULT_PI_AGENT_ID, normalizePatch(input));
  return mustGetPiAgent(db, DEFAULT_PI_AGENT_ID);
}

export function getPiAgent(db: RunnerDatabase, id: string): PiAgent | null {
  return getByID(db, TABLE, COLUMNS, id, mapPiAgent);
}

export function getPiSupervisor(db: RunnerDatabase): PiAgent | null {
  return getPiAgent(db, DEFAULT_PI_AGENT_ID);
}

function mustGetPiAgent(db: RunnerDatabase, id: string): PiAgent {
  const record = getPiAgent(db, id);
  if (!record) throw new Error("pi agent missing after write");
  return record;
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
