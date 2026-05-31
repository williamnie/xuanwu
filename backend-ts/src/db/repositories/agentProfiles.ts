import type { RunnerDatabase } from "../database.ts";

export type AgentProfile = {
  approval_policy: string;
  created_at: string;
  default_instructions: string;
  id: string;
  model: string;
  name: string;
  plugin_intents: string;
  provider: string;
  reasoning_effort: string;
  sandbox: string;
  skill_intents: string;
  updated_at: string;
};

type AgentProfileRow = Record<keyof AgentProfile, unknown>;

const AGENT_PROFILE_COLUMNS = `id, name, provider, model, reasoning_effort,
  approval_policy, sandbox, default_instructions, skill_intents_json,
  plugin_intents_json, created_at, updated_at`;

export function listAgentProfiles(db: RunnerDatabase): AgentProfile[] {
  return db.sqlite.query<AgentProfileRow, []>(`
    select ${AGENT_PROFILE_COLUMNS} from agent_profiles order by created_at asc, id asc
  `).all().map(mapAgentProfileRow);
}

export function getAgentProfile(db: RunnerDatabase, id: string): AgentProfile | null {
  const profileID = id.trim();
  if (profileID === "") return null;
  const row = db.sqlite.query<AgentProfileRow, [string]>(`
    select ${AGENT_PROFILE_COLUMNS} from agent_profiles where id=?
  `).get(profileID);
  return row ? mapAgentProfileRow(row) : null;
}

function mapAgentProfileRow(row: AgentProfileRow): AgentProfile {
  return {
    id: requiredString(row.id, "agent_profiles.id"),
    name: requiredString(row.name, "agent_profiles.name"),
    provider: optionalString(row.provider, "codex"),
    model: optionalString(row.model, "codex-default"),
    reasoning_effort: optionalString(row.reasoning_effort),
    approval_policy: optionalString(row.approval_policy),
    sandbox: optionalString(row.sandbox),
    default_instructions: optionalString(row.default_instructions),
    skill_intents: optionalString(row.skill_intents_json, "[]"),
    plugin_intents: optionalString(row.plugin_intents_json, "[]"),
    created_at: requiredString(row.created_at, "agent_profiles.created_at"),
    updated_at: requiredString(row.updated_at, "agent_profiles.updated_at")
  };
}

function optionalString(value: unknown, fallback = ""): string {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== "string") throw new Error("expected string row value");
  const trimmed = value.trim();
  return trimmed === "" ? fallback : trimmed;
}

function requiredString(value: unknown, label: string): string {
  const text = optionalString(value);
  if (text === "") throw new Error(`${label} is required`);
  return text;
}
