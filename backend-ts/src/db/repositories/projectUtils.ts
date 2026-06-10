import { basename, sep } from "node:path";
import { normalizeMcpPolicy } from "../../mcp/policy.ts";
import { normalizeSkillPolicy } from "../../skills/intents.ts";

export type ProjectWriteInput = Partial<Record<keyof NormalizedProjectWrite, unknown>>;
export type ProjectPatchInput = ProjectWriteInput;
export type NormalizedProjectPatch = Partial<NormalizedProjectWrite>;

export type NormalizedProjectWrite = {
  approval_policy: string;
  default_mcp_policy: string;
  default_skill_policy: string;
  auto_run: number;
  cwd: string;
  default_agent_profile_id: string;
  default_service_tier: string;
  id: string;
  model: string;
  name: string;
  provider: string;
  provider_config_json: string;
  sandbox: string;
};

export function normalizeProjectForWrite(input: ProjectWriteInput): NormalizedProjectWrite {
  const cwd = cleanString(input.cwd);
  return {
    id: cleanString(input.id),
    name: cleanString(input.name) || projectNameFromCWD(cwd),
    cwd,
    provider: normalizeProjectProvider(input.provider),
    provider_config_json: normalizeProjectProviderConfig(input.provider_config_json),
    auto_run: normalizeProjectAutoRun(input.auto_run),
    model: normalizeProjectModel(input.model),
    approval_policy: cleanString(input.approval_policy) || "never",
    sandbox: cleanString(input.sandbox) || "workspace-write",
    default_agent_profile_id: normalizeIdentifier(input.default_agent_profile_id),
    default_service_tier: cleanString(input.default_service_tier),
    default_mcp_policy: normalizeMcpPolicy(input.default_mcp_policy),
    default_skill_policy: normalizeSkillPolicy(input.default_skill_policy)
  };
}

export function normalizeProjectPatch(current: NormalizedProjectWrite, input: ProjectPatchInput): NormalizedProjectPatch {
  const patch: NormalizedProjectPatch = {};
  if (hasPatchValue(input, "cwd")) patch.cwd = cleanString(input.cwd);
  if (hasPatchValue(input, "name")) patch.name = cleanString(input.name) || projectNameFromCWD(patch.cwd ?? current.cwd);
  if (patch.cwd && !hasPatchValue(input, "name")) patch.name = projectNameFromCWD(patch.cwd);
  if (hasPatchValue(input, "provider")) patch.provider = normalizeProjectProvider(input.provider);
  if (hasPatchValue(input, "provider_config_json")) patch.provider_config_json = normalizeProjectProviderConfig(input.provider_config_json);
  if (hasPatchValue(input, "auto_run")) patch.auto_run = normalizeProjectAutoRun(input.auto_run);
  if (hasPatchValue(input, "model")) patch.model = normalizeProjectModel(input.model);
  if (hasPatchValue(input, "approval_policy")) patch.approval_policy = cleanString(input.approval_policy);
  if (hasPatchValue(input, "sandbox")) patch.sandbox = cleanString(input.sandbox);
  if (hasPatchValue(input, "default_agent_profile_id")) patch.default_agent_profile_id = normalizeIdentifier(input.default_agent_profile_id);
  if (hasPatchValue(input, "default_service_tier")) patch.default_service_tier = cleanString(input.default_service_tier);
  if (hasPatchValue(input, "default_mcp_policy")) patch.default_mcp_policy = normalizeMcpPolicy(input.default_mcp_policy);
  if (hasPatchValue(input, "default_skill_policy")) patch.default_skill_policy = normalizeSkillPolicy(input.default_skill_policy);
  return patch;
}

export function normalizeProjectProvider(value: unknown): string {
  return cleanString(value).toLowerCase() || "codex";
}

export function normalizeProjectProviderConfig(value: unknown): string {
  return cleanString(value) || "{}";
}

export function normalizeProjectModel(value: unknown): string {
  const model = cleanString(value);
  if (model === "" || model.toLowerCase().startsWith("gemini-")) return "codex-default";
  return model;
}

export function projectNameFromCWD(cwd: string): string {
  const trimmed = cleanString(cwd).replace(new RegExp(`${escapeRegExp(sep)}+$`), "");
  const name = basename(trimmed);
  return name === "." || name === sep || name === "" ? "project" : name;
}

export function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function hasPatchValue(input: ProjectPatchInput, key: keyof NormalizedProjectWrite): boolean {
  return Object.hasOwn(input, key) && input[key] !== null && input[key] !== undefined;
}

function normalizeProjectAutoRun(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) ? value : 0;
}

function normalizeIdentifier(value: unknown): string {
  let out = "";
  let lastDash = false;
  for (const char of cleanString(value).toLowerCase()) {
    if (/^[a-z0-9_-]$/.test(char)) {
      out += char;
      lastDash = char === "-";
    } else if (!lastDash) {
      out += "-";
      lastDash = true;
    }
  }
  return out.replace(/^-+|-+$/g, "");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
