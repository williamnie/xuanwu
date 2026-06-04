import { EXECUTION_AGENT_ROLES, isExecutionAgentRole, normalizeExecutionAgentRole, type ExecutionAgentRole } from "../agents/roles.ts";
import type { RunnerDatabase } from "../db/database.ts";
import { getAgentProfile, listAgentProfiles, type AgentProfile } from "../db/repositories/agentProfiles.ts";
import { getIssue, type Issue } from "../db/repositories/issues.ts";
import { getProject, ProjectNotFoundError, type Project } from "../db/repositories/projects.ts";
import { mergeSkillIntents, parseSkillIntentList } from "../skills/intents.ts";
import { needsUserComment, workflowIssuePayload } from "./agentOrchestrationPayloads.ts";

export const AGENT_ROLES = EXECUTION_AGENT_ROLES;
export type AgentRole = ExecutionAgentRole;

export type AgentRecommendationInput = {
  agent_profile_id?: string;
  issue_id?: number;
  project_id?: string;
  role?: string;
};
export type AgentWorkflowInput = AgentRecommendationInput & {
  instructions?: string;
  rationale?: string;
  recommended_skill_intents?: string[];
  report_type?: string;
  required_skill_intents?: string[];
  target_issue_id?: number;
  title?: string;
  verification_plan?: string;
};
export type ExecutorAssignmentInput = AgentRecommendationInput & {
  issue_id: number;
  rationale?: string;
  recommended_skill_intents?: string[];
  required_skill_intents?: string[];
};
export type NeedsUserEscalationInput = { issue_id: number; reason: string; requested_action?: string };
export type AgentOrchestrationProposal = {
  actionType: string;
  issueID?: number;
  payload: Record<string, unknown>;
  projectID?: string;
  rationale?: string;
};
export type AgentRecommendation = {
  agent_role: AgentRole;
  approval_policy: string;
  issue_id: number;
  model: string;
  profile_id: string;
  profile_name: string;
  project_id: string;
  provider: string;
  reason: string;
  recommended_skill_intents: string[];
  reasoning_effort: string;
  required_skill_intents: string[];
  sandbox: string;
};

export function recommendExecutorProfile(
  db: RunnerDatabase,
  contextProject: Project | undefined,
  input: AgentRecommendationInput
): AgentRecommendation {
  const role = normalizeAgentRole(input.role);
  const issue = optionalIssue(db, input.issue_id);
  const project = resolveProject(db, contextProject, issue, input.project_id);
  const skills = roleSkills(role, issue, input);
  const profile = selectProfile(db, project, issue, role, skills.required, input.agent_profile_id);
  return recommendationFor(project, issue, role, skills, profile);
}

export function createExecutorAssignmentProposal(
  db: RunnerDatabase,
  contextProject: Project | undefined,
  input: ExecutorAssignmentInput
): AgentOrchestrationProposal {
  const issue = requireIssue(db, input.issue_id);
  const recommendation = recommendExecutorProfile(db, contextProject, input);
  if (recommendation.profile_id === "") throw new Error("no executor profile recommendation available");
  return {
    actionType: "issue.update_refinement",
    issueID: issue.id,
    payload: { issue_id: issue.id, patch: assignmentPatch(issue, input, recommendation) },
    projectID: issue.project_id,
    rationale: input.rationale
  };
}

export function createAgentWorkflowProposal(
  db: RunnerDatabase,
  contextProject: Project | undefined,
  input: AgentWorkflowInput
): AgentOrchestrationProposal {
  const role = normalizeAgentRole(input.role);
  const target = optionalIssue(db, input.target_issue_id ?? input.issue_id);
  const project = resolveProject(db, contextProject, target, input.project_id);
  const recommendation = recommendExecutorProfile(db, project, { ...input, issue_id: target?.id, role });
  return {
    actionType: "issue.create",
    issueID: target?.id,
    payload: workflowIssuePayload(project, target, role, recommendation, input),
    projectID: project.id,
    rationale: input.rationale
  };
}

export function createNeedsUserEscalationProposal(
  db: RunnerDatabase,
  input: NeedsUserEscalationInput
): AgentOrchestrationProposal {
  const issue = requireIssue(db, input.issue_id);
  return {
    actionType: "issue.comment",
    issueID: issue.id,
    payload: { body: needsUserComment(input), issue_id: issue.id },
    projectID: issue.project_id,
    rationale: input.reason
  };
}

export function resolveIssueAgentRole(issue: Pick<Issue, "workflow_snapshot_json">): AgentRole {
  const snapshot = parseWorkflowSnapshot(issue.workflow_snapshot_json);
  const value = cleanString(snapshot.agent_role ?? snapshot.role);
  return isAgentRole(value) ? value : "executor";
}

export function resolveExecutorSelection(db: RunnerDatabase, project: Project, issue: Issue): AgentRecommendation {
  return recommendExecutorProfile(db, project, { issue_id: issue.id, role: resolveIssueAgentRole(issue) });
}

function recommendationFor(
  project: Project,
  issue: Issue | null,
  role: AgentRole,
  skills: { recommended: string[]; required: string[] },
  profile: AgentProfile | null
): AgentRecommendation {
  return {
    agent_role: role,
    approval_policy: profile?.approval_policy || project.approval_policy,
    issue_id: issue?.id ?? 0,
    model: profile?.model || project.model,
    profile_id: profile?.id ?? "",
    profile_name: profile?.name ?? "",
    project_id: project.id,
    provider: profile?.provider || project.provider,
    reason: profileReason(project, issue, profile),
    recommended_skill_intents: skills.recommended,
    reasoning_effort: profile?.reasoning_effort ?? "",
    required_skill_intents: skills.required,
    sandbox: profile?.sandbox || project.sandbox
  };
}

function selectProfile(
  db: RunnerDatabase,
  project: Project,
  issue: Issue | null,
  role: AgentRole,
  required: string[],
  explicitID = ""
): AgentProfile | null {
  const explicit = profileByID(db, explicitID);
  if (explicit) return explicit;
  const issueProfile = role === "executor" ? profileByID(db, issue?.agent_profile_id) : null;
  if (issueProfile) return issueProfile;
  const defaultProfile = profileByID(db, project.default_agent_profile_id);
  return defaultProfile ?? bestProfile(db, project.provider, role, required);
}

function bestProfile(db: RunnerDatabase, provider: string, role: AgentRole, required: string[]): AgentProfile | null {
  return listAgentProfiles(db)
    .map((profile) => ({ profile, score: profileScore(profile, provider, role, required) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.profile.id.localeCompare(b.profile.id))[0]?.profile ?? null;
}

function profileScore(profile: AgentProfile, provider: string, role: AgentRole, required: string[]): number {
  const intents = new Set(parseSkillIntentList(profile.skill_intents));
  const skillScore = required.filter((id) => intents.has(id)).length * 5;
  const providerScore = profile.provider === provider ? 2 : 0;
  const roleScore = `${profile.id} ${profile.name}`.toLowerCase().includes(role) ? 3 : 0;
  const matchScore = skillScore + roleScore;
  return matchScore === 0 ? 0 : matchScore + providerScore;
}

function roleSkills(
  role: AgentRole,
  issue: Issue | null,
  input: AgentRecommendationInput
): { recommended: string[]; required: string[] } {
  return {
    required: mergeSkillIntents(roleRequiredSkills(role), issue?.required_skill_intents, inputSkill(input, "required_skill_intents")),
    recommended: mergeSkillIntents(issue?.recommended_skill_intents, inputSkill(input, "recommended_skill_intents"))
  };
}

function assignmentPatch(
  issue: Issue,
  input: ExecutorAssignmentInput,
  recommendation: AgentRecommendation
): Record<string, unknown> {
  return {
    agent_profile_id: recommendation.profile_id,
    recommended_skill_intents: mergeSkillIntents(issue.recommended_skill_intents, input.recommended_skill_intents),
    required_skill_intents: mergeSkillIntents(
      issue.required_skill_intents,
      input.required_skill_intents,
      recommendation.required_skill_intents
    )
  };
}

function resolveProject(db: RunnerDatabase, contextProject: Project | undefined, issue: Issue | null, projectID: unknown): Project {
  const id = issue?.project_id || cleanString(projectID) || contextProject?.id || "";
  if (id === "") throw new ProjectNotFoundError();
  const project = contextProject?.id === id ? contextProject : getProject(db, id);
  if (!project) throw new ProjectNotFoundError();
  return project;
}

function optionalIssue(db: RunnerDatabase, id: unknown): Issue | null {
  const issueID = positiveID(id);
  return issueID > 0 ? requireIssue(db, issueID) : null;
}

function requireIssue(db: RunnerDatabase, id: number): Issue {
  const issue = getIssue(db, id);
  if (!issue) throw new ProjectNotFoundError();
  return issue;
}

function profileByID(db: RunnerDatabase, id: unknown): AgentProfile | null {
  const profileID = cleanString(id);
  return profileID === "" ? null : getAgentProfile(db, profileID);
}

function profileReason(project: Project, issue: Issue | null, profile: AgentProfile | null): string {
  if (!profile) return `fallback to project provider ${project.provider}`;
  if (issue?.agent_profile_id === profile.id) return "issue assigned agent_profile_id";
  if (project.default_agent_profile_id === profile.id) return "project default_agent_profile_id";
  return "matched role/provider/skill intent strategy";
}

function roleRequiredSkills(role: AgentRole): string[] {
  if (role === "verifier") return ["verification-before-completion"];
  if (role === "reviewer") return ["requesting-code-review"];
  if (role === "reporter") return ["codex-issue-runner"];
  return [];
}

function normalizeAgentRole(value: unknown): AgentRole {
  return normalizeExecutionAgentRole(value);
}

function isAgentRole(value: string): value is AgentRole {
  return isExecutionAgentRole(value);
}

function inputSkill(input: AgentRecommendationInput, key: "recommended_skill_intents" | "required_skill_intents"): unknown {
  return (input as Record<string, unknown>)[key];
}

function parseWorkflowSnapshot(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function positiveID(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
