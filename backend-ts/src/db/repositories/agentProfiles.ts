import type { RunnerDatabase } from "../database.ts";
import { issueTimestamp, normalizeIdentifier } from "./issueCreate.ts";
import { ProjectNotFoundError } from "./projects.ts";
import type { ExecutionPolicyRequest } from "../../providers/core/policyContracts.ts";
import {
  executionPolicyInput,
  executionPolicyJSON,
  legacyProjection,
  parseExecutionPolicyWrite,
  policyFromLegacyWrite,
  readStoredExecutionPolicy
} from "../../providers/core/policyPersistence.ts";

export type AgentProfile = {
  approval_policy: string;
  created_at: string;
  default_instructions: string;
  execution_policy?: ExecutionPolicyRequest;
  execution_policy_json: string;
  execution_policy_source: string;
  execution_policy_warnings: string[];
  id: string;
  model: string;
  name: string;
  plugin_intents: string;
  provider: string;
  reasoning_effort: string;
  sandbox: string;
  service_tier: string;
  skill_intents: string;
  updated_at: string;
};

type AgentProfileRow = Omit<Record<keyof AgentProfile, unknown>, "execution_policy" | "execution_policy_source" | "execution_policy_warnings" | "plugin_intents" | "skill_intents"> & {
  plugin_intents_json: unknown;
  skill_intents_json: unknown;
};
type AgentProfileInput = Partial<Record<keyof AgentProfile, unknown>>;

const AGENT_PROFILE_COLUMNS = `id, name, provider, model, reasoning_effort,
  approval_policy, sandbox, execution_policy_json, service_tier, default_instructions, skill_intents_json,
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

export function createAgentProfile(db: RunnerDatabase, input: AgentProfileInput): AgentProfile {
  const profile = normalizeAgentProfile(input);
  if (profile.id === "") throw new Error("agent profile id 不能为空");
  if (profile.name === "") throw new Error("agent profile name 不能为空");
  const timestamp = issueTimestamp();
  db.sqlite.run(`insert into agent_profiles
    (id, name, provider, model, reasoning_effort, approval_policy, sandbox, execution_policy_json,
     service_tier, default_instructions, skill_intents_json, plugin_intents_json, created_at, updated_at)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [profile.id, profile.name, profile.provider, profile.model, profile.reasoning_effort,
      profile.approval_policy, profile.sandbox, profile.execution_policy_json, profile.service_tier, profile.default_instructions,
      profile.skill_intents, profile.plugin_intents, timestamp, timestamp]);
  return mustGetAgentProfile(db, profile.id);
}

export function updateAgentProfile(db: RunnerDatabase, id: string, input: AgentProfileInput): AgentProfile {
  const profileID = id.trim();
  const current = getAgentProfile(db, profileID);
  if (!current) throw new ProjectNotFoundError();
  const next = normalizeAgentProfile(profileUpdateInput(current, input, profileID));
  if (next.name === "") throw new Error("agent profile name 不能为空");
  db.sqlite.run(`update agent_profiles set name=?, provider=?, model=?, reasoning_effort=?,
    approval_policy=?, sandbox=?, execution_policy_json=?, service_tier=?, default_instructions=?, skill_intents_json=?,
    plugin_intents_json=?, updated_at=? where id=?`,
    [next.name, next.provider, next.model, next.reasoning_effort, next.approval_policy,
      next.sandbox, next.execution_policy_json, next.service_tier, next.default_instructions, next.skill_intents, next.plugin_intents,
      issueTimestamp(), profileID]);
  return mustGetAgentProfile(db, profileID);
}

export function deleteAgentProfile(db: RunnerDatabase, id: string): void {
  const profileID = id.trim();
  const result = db.sqlite.run("delete from agent_profiles where id=?", [profileID]);
  if (result.changes === 0) throw new ProjectNotFoundError();
  db.sqlite.run("update projects set default_agent_profile_id='', updated_at=? where default_agent_profile_id=?", [issueTimestamp(), profileID]);
}

function normalizeAgentProfile(input: AgentProfileInput): AgentProfile {
  const provider = cleanString(input.provider).toLowerCase() || "codex";
  const rawPolicy = executionPolicyInput(input);
  const policy = rawPolicy !== undefined
    ? parseExecutionPolicyWrite(rawPolicy, { allowEmpty: true })
    : (Object.hasOwn(input, "sandbox") || Object.hasOwn(input, "approval_policy"))
      ? policyFromLegacyWrite({ sandbox: input.sandbox, approvalPolicy: input.approval_policy, scope: "profile" })
      : undefined;
  const projection = policy ? legacyProjection(policy) : {
    approval_policy: cleanString(input.approval_policy),
    sandbox: cleanString(input.sandbox)
  };
  return {
    id: normalizeIdentifier(input.id), name: cleanString(input.name),
    provider,
    model: normalizeModel(input.model, provider), reasoning_effort: cleanString(input.reasoning_effort),
    approval_policy: projection.approval_policy, sandbox: projection.sandbox,
    ...(policy ? { execution_policy: policy } : {}),
    execution_policy_json: executionPolicyJSON(policy),
    execution_policy_source: policy ? "profile" : "inherit",
    execution_policy_warnings: [],
    service_tier: cleanString(input.service_tier),
    default_instructions: cleanString(input.default_instructions),
    skill_intents: normalizeJSONList(input.skill_intents),
    plugin_intents: normalizeJSONList(input.plugin_intents),
    created_at: "", updated_at: ""
  };
}

function profileUpdateInput(current: AgentProfile, input: AgentProfileInput, id: string): AgentProfileInput {
  const patch = patchValues(input);
  const merged: AgentProfileInput = { ...current, ...patch, id };
  const hasPolicy = Object.hasOwn(input, "execution_policy") || Object.hasOwn(input, "execution_policy_json");
  const hasLegacy = Object.hasOwn(input, "approval_policy") || Object.hasOwn(input, "sandbox");
  if (hasPolicy) return merged;
  if (hasLegacy) {
    const policy = policyFromLegacyWrite({
      approvalPolicy: Object.hasOwn(input, "approval_policy") ? input.approval_policy : current.approval_policy,
      sandbox: Object.hasOwn(input, "sandbox") ? input.sandbox : current.sandbox,
      scope: "profile"
    });
    merged.execution_policy = policy;
    delete merged.execution_policy_json;
    return merged;
  }
  delete merged.execution_policy;
  merged.execution_policy_json = current.execution_policy_json;
  return merged;
}

function patchValues(input: AgentProfileInput): AgentProfileInput {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== null && value !== undefined));
}

function normalizeModel(value: unknown, provider = "codex"): string {
  const model = cleanString(value);
  if (provider !== "codex" && model === "codex-default") return "";
  return model === "" || model.toLowerCase().startsWith("gemini-")
    ? provider === "codex" ? "codex-default" : ""
    : model;
}

function normalizeJSONList(value: unknown): string {
  return cleanString(value) || "[]";
}

function mustGetAgentProfile(db: RunnerDatabase, id: string): AgentProfile {
  const profile = getAgentProfile(db, id);
  if (!profile) throw new Error("agent profile missing after write");
  return profile;
}

function mapAgentProfileRow(row: AgentProfileRow): AgentProfile {
  const provider = optionalString(row.provider, "codex");
  const storedPolicy = readStoredExecutionPolicy({
    approvalPolicy: row.approval_policy,
    json: row.execution_policy_json,
    sandbox: row.sandbox,
    scope: "profile"
  });
  return {
    id: requiredString(row.id, "agent_profiles.id"),
    name: requiredString(row.name, "agent_profiles.name"),
    provider,
    model: normalizeModel(optionalString(row.model), provider),
    reasoning_effort: optionalString(row.reasoning_effort),
    approval_policy: optionalString(row.approval_policy),
    sandbox: optionalString(row.sandbox),
    ...(storedPolicy.policy ? { execution_policy: storedPolicy.policy } : {}),
    execution_policy_json: optionalString(row.execution_policy_json, "{}"),
    execution_policy_source: storedPolicy.source,
    execution_policy_warnings: storedPolicy.warnings,
    service_tier: optionalString(row.service_tier),
    default_instructions: optionalString(row.default_instructions),
    skill_intents: optionalString(row.skill_intents_json, "[]"),
    plugin_intents: optionalString(row.plugin_intents_json, "[]"),
    created_at: requiredString(row.created_at, "agent_profiles.created_at"),
    updated_at: requiredString(row.updated_at, "agent_profiles.updated_at")
  };
}

function cleanString(value: unknown): string { return typeof value === "string" ? value.trim() : ""; }
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
