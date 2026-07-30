import type { AgentProfile } from "../db/repositories/agentProfiles.ts";
import { parseSkillIntentList } from "../skills/intents.ts";
import type { AgentRole } from "./agentOrchestration.ts";

export type RoleProfileSelectorInput = {
  allowStrategy?: boolean;
  explicitProfileId?: string;
  issueProfileId?: string;
  profiles: AgentProfile[];
  projectDefaultProfileId?: string;
  projectProvider: string;
  requiredSkillIntents: string[];
  role: AgentRole;
};

export type RoleProfileSelection = {
  profile: AgentProfile | null;
  selection_reason: string;
};

type ProfileCandidate = { profile: AgentProfile; score: number };

export function selectRoleProfile(input: RoleProfileSelectorInput): RoleProfileSelection {
  const missing: string[] = [];
  const explicit = selectedByID(input, "explicit agent_profile_id override", input.explicitProfileId, missing);
  if (explicit) return explicit;
  const issue = selectedByID(input, "issue assigned agent_profile_id", input.issueProfileId, missing);
  if (issue) return issue;
  const projectDefault = selectedByID(input, "project default_agent_profile_id", input.projectDefaultProfileId, missing);
  if (projectDefault) return projectDefault;
  if (input.allowStrategy === false) {
    return { profile: null, selection_reason: fallbackReason(input.projectProvider, missing) };
  }
  const best = bestProfile(input);
  if (best) return { profile: best.profile, selection_reason: matchReason(input, best, missing) };
  return { profile: null, selection_reason: fallbackReason(input.projectProvider, missing) };
}

function selectedByID(
  input: RoleProfileSelectorInput,
  label: string,
  id: unknown,
  missing: string[]
): RoleProfileSelection | undefined {
  const profileID = cleanString(id);
  if (profileID === "") return undefined;
  const profile = input.profiles.find((item) => item.id === profileID);
  if (profile) return { profile, selection_reason: reasonWithMissing(label, missing) };
  missing.push(`${label} missing: ${profileID}`);
  return undefined;
}

function bestProfile(input: RoleProfileSelectorInput): ProfileCandidate | undefined {
  return input.profiles
    .map((profile) => ({ profile, score: profileScore(profile, input) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.profile.id.localeCompare(b.profile.id))[0];
}

function profileScore(profile: AgentProfile, input: RoleProfileSelectorInput): number {
  const intents = new Set(parseSkillIntentList(profile.skill_intents));
  const skillScore = input.requiredSkillIntents.filter((id) => intents.has(id)).length * 5;
  const providerScore = profile.provider === input.projectProvider ? 2 : 0;
  const roleScore = `${profile.id} ${profile.name}`.toLowerCase().includes(input.role) ? 3 : 0;
  const matchScore = skillScore + roleScore;
  return matchScore === 0 ? 0 : matchScore + providerScore;
}

function matchReason(input: RoleProfileSelectorInput, candidate: ProfileCandidate, missing: string[]): string {
  const required = input.requiredSkillIntents.join(",");
  return reasonWithMissing([
    "matched role/provider/skill intent strategy",
    `profile=${candidate.profile.id}`,
    `role=${input.role}`,
    `project_provider=${input.projectProvider}`,
    required ? `required_skill_intents=${required}` : ""
  ].filter(Boolean).join("; "), missing);
}

function fallbackReason(projectProvider: string, missing: string[]): string {
  return [
    `fallback to project provider ${projectProvider}`,
    ...missing,
    "no matching role/provider/skill intent profile"
  ].join("; ");
}

function reasonWithMissing(reason: string, missing: string[]): string {
  return [reason, ...missing].join("; ");
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
