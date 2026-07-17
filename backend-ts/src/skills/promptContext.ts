import type { RunnerDatabase } from "../db/database.ts";
import { createPiActionEvent, getPiDelegation } from "../db/repositories/pi.ts";
import { getIssue } from "../db/repositories/issues.ts";
import type { Project } from "../db/repositories/projects.ts";
import type { PiGatePolicy } from "../pi/actionGate.ts";
import { formatUntrustedContent } from "../security/promptInjectionDefense.ts";
import { mergeSkillIntents, parseSkillIntentList, parseSkillPolicy } from "./intents.ts";
import { listSkillRegistry, type SkillMetadata } from "./registry.ts";

export type SkillPromptContextInput = {
  authorization?: PiGatePolicy;
  conversationID?: string;
  delegationID?: string;
  heartbeatID?: string;
  issueID?: number;
  project?: Project;
};

export type SkillPromptContext = {
  audit: SkillPromptContextAudit;
  promptSection: string;
};

export type SkillPromptContextAudit = {
  authorization_sources: string[];
  conversation_id: string;
  delegation_id: string;
  heartbeat_id: string;
  injected_skill_ids: string[];
  injected_skills: SkillPromptSummary[];
  issue_id: number;
  missing_skill_intents: string[];
  project_id: string;
  requested_skill_intents: string[];
  unauthorized_skill_intents: string[];
};

type AllowSource = { ids: string[]; name: string };
type SkillPromptSummary = Pick<SkillMetadata,
  "allowed_roles" | "description" | "id" | "name" | "risk_level" | "source_path" | "summary" | "trigger_rules"
>;

export function buildSkillPromptContext(db: RunnerDatabase, input: SkillPromptContextInput): SkillPromptContext {
  const issue = scopedIssue(db, input);
  const allowSources = skillAllowSources(db, input);
  const requested = requestedSkillIntents(input.project, issue);
  const fallback = mergeSkillIntents(...allowSources.map((source) => source.ids));
  const candidates = requested.length > 0 ? requested : fallback;
  const filtered = filterUnauthorized(candidates, allowSources);
  const registry = skillRegistryByID();
  const injected = filtered.authorized.flatMap((id) => registry.get(id) ?? []);
  const audit = promptContextAudit(input, issue?.id ?? 0, requested, allowSources, filtered, injected);
  return { audit, promptSection: formatPromptSection(audit) };
}

export function recordSkillPromptContextAudit(
  db: RunnerDatabase,
  input: SkillPromptContextInput,
  audit: SkillPromptContextAudit
): void {
  if (!shouldAudit(audit)) return;
  createPiActionEvent(db, {
    action_id: `skill-prompt-context:${audit.conversation_id || audit.heartbeat_id || crypto.randomUUID()}`,
    actor: "pi_runtime",
    conversation_id: audit.conversation_id,
    delegation_id: audit.delegation_id,
    event_type: "skill_prompt_context_injected",
    heartbeat_id: audit.heartbeat_id,
    issue_id: audit.issue_id,
    payload_json: JSON.stringify(auditPayload(audit)),
    project_id: audit.project_id,
    reason: "injected restricted skill metadata into PI prompt"
  });
}

function shouldAudit(audit: SkillPromptContextAudit): boolean {
  return audit.injected_skill_ids.length > 0 ||
    audit.requested_skill_intents.length > 0 ||
    audit.unauthorized_skill_intents.length > 0 ||
    audit.missing_skill_intents.length > 0;
}

function requestedSkillIntents(project: Project | undefined, issue: ReturnType<typeof getIssue>): string[] {
  const policy = parseSkillPolicy(project?.default_skill_policy);
  return mergeSkillIntents(
    policy.required,
    policy.recommended,
    issue?.required_skill_intents,
    issue?.recommended_skill_intents
  );
}

function skillAllowSources(db: RunnerDatabase, input: SkillPromptContextInput): AllowSource[] {
  return [
    { name: "project.default_skill_policy.allowed", ids: parseSkillPolicy(input.project?.default_skill_policy).allowed ?? [] },
    { name: "runtime.authorization.allowedSkillIntents", ids: runtimeAllowedSkills(input.authorization) },
    { name: "delegation.allowed_skill_intents", ids: delegationAllowedSkills(db, input.delegationID) }
  ].filter((source) => source.ids.length > 0);
}

function runtimeAllowedSkills(policy: PiGatePolicy | undefined): string[] {
  return mergeSkillIntents(policy?.allowedSkillIntents, policy?.allowed_skill_intents);
}

function delegationAllowedSkills(db: RunnerDatabase, id: string | undefined): string[] {
  const delegationID = cleanString(id);
  if (delegationID === "") return [];
  return parseSkillIntentList(getPiDelegation(db, delegationID)?.allowed_skill_intents_json);
}

function filterUnauthorized(candidates: string[], sources: AllowSource[]) {
  if (sources.length === 0) return { authorized: [], unauthorized: candidates };
  const allowedSets = sources.map((source) => new Set(source.ids));
  const authorized = candidates.filter((id) => allowedSets.every((allowed) => allowed.has(id)));
  return { authorized, unauthorized: candidates.filter((id) => !authorized.includes(id)) };
}

function skillRegistryByID(): Map<string, SkillMetadata> {
  return new Map(listSkillRegistry().map((skill) => [skill.id, skill]));
}

function promptContextAudit(
  input: SkillPromptContextInput,
  issueID: number,
  requested: string[],
  allowSources: AllowSource[],
  filtered: ReturnType<typeof filterUnauthorized>,
  injected: SkillMetadata[]
): SkillPromptContextAudit {
  const injectedIDs = injected.map((skill) => skill.id);
  return {
    authorization_sources: allowSources.map((source) => source.name),
    conversation_id: cleanString(input.conversationID),
    delegation_id: cleanString(input.delegationID),
    heartbeat_id: cleanString(input.heartbeatID),
    injected_skill_ids: injectedIDs,
    injected_skills: injected.map(skillPromptSummary),
    issue_id: issueID,
    missing_skill_intents: filtered.authorized.filter((id) => !injectedIDs.includes(id)),
    project_id: input.project?.id ?? "",
    requested_skill_intents: requested,
    unauthorized_skill_intents: filtered.unauthorized
  };
}

function formatPromptSection(audit: SkillPromptContextAudit): string {
  return [
    "Relevant Skill Metadata:",
    formatUntrustedContent(audit.injected_skills, "skill"),
    "Skill metadata policy: only project/issue/delegation-authorized skill summaries above are visible in this prompt.",
    "Authorized injected skill ids:",
    JSON.stringify(audit.injected_skill_ids)
  ].join("\n");
}

function auditPayload(audit: SkillPromptContextAudit): Record<string, unknown> {
  return {
    authorization_sources: audit.authorization_sources,
    injected_skill_ids: audit.injected_skill_ids,
    injected_skill_summaries: audit.injected_skills.map((skill) => ({
      id: skill.id,
      risk_level: skill.risk_level,
      summary: truncate(skill.summary)
    })),
    missing_skill_intents: audit.missing_skill_intents,
    requested_skill_intents: audit.requested_skill_intents,
    scope: {
      conversation_id: audit.conversation_id,
      delegation_id: audit.delegation_id,
      heartbeat_id: audit.heartbeat_id,
      issue_id: audit.issue_id,
      project_id: audit.project_id
    },
    unauthorized_skill_intents: audit.unauthorized_skill_intents
  };
}

function scopedIssue(db: RunnerDatabase, input: SkillPromptContextInput) {
  if (!Number.isSafeInteger(input.issueID) || (input.issueID ?? 0) <= 0) return null;
  const issue = getIssue(db, input.issueID ?? 0);
  if (!issue || (input.project?.id && issue.project_id !== input.project.id)) return null;
  return issue;
}

function skillPromptSummary(skill: SkillMetadata): SkillPromptSummary {
  return {
    allowed_roles: skill.allowed_roles,
    description: skill.description,
    id: skill.id,
    name: skill.name,
    risk_level: skill.risk_level,
    source_path: skill.source_path,
    summary: skill.summary,
    trigger_rules: skill.trigger_rules
  };
}

function truncate(value: string): string {
  return value.length > 180 ? `${value.slice(0, 177)}...` : value;
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
