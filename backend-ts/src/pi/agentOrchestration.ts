import { EXECUTION_AGENT_ROLES, isExecutionAgentRole, normalizeExecutionAgentRole, type ExecutionAgentRole } from "../agents/roles.ts";
import type { RunnerDatabase } from "../db/database.ts";
import type { AgentProfile } from "../db/repositories/agentProfiles.ts";
import { listAgentProfiles } from "../db/repositories/agentProfiles.ts";
import { getIssue, type Issue } from "../db/repositories/issues.ts";
import { getProject, ProjectNotFoundError, type Project } from "../db/repositories/projects.ts";
import { mergeSkillIntents, parseSkillPolicy } from "../skills/intents.ts";
import { needsUserComment, workflowIssuePayload } from "./agentOrchestrationPayloads.ts";
import { selectRoleProfile, type RoleProfileSelection } from "./roleProfileSelector.ts";

export const AGENT_ROLES = EXECUTION_AGENT_ROLES;
export type AgentRole = ExecutionAgentRole;

export type AgentRecommendationInput = {
  agent_profile_id?: string;
  issue_id?: number;
  project_id?: string;
  role?: string;
};
export type AgentWorkflowInput = AgentRecommendationInput & {
  goal_id?: string;
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
  goalID?: string;
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
  selection_reason: string;
  sandbox: string;
  service_tier: string;
};

export function recommendExecutorProfile(
  db: RunnerDatabase,
  contextProject: Project | undefined,
  input: AgentRecommendationInput
): AgentRecommendation {
  const role = normalizeAgentRole(input.role);
  const issue = optionalIssue(db, input.issue_id);
  const project = resolveProject(db, contextProject, issue, input.project_id);
  const skills = roleSkills(role, project, issue, input);
  const selection = selectRoleProfile({
    explicitProfileId: input.agent_profile_id,
    issueProfileId: issue?.agent_profile_id,
    profiles: listAgentProfiles(db),
    projectDefaultProfileId: project.default_agent_profile_id,
    projectProvider: project.provider,
    requiredSkillIntents: skills.required,
    role
  });
  return recommendationFor(project, issue, role, skills, selection);
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
    actionType: "agent.executor_assign",
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
    goalID: cleanString(input.goal_id),
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
  const role = resolveIssueAgentRole(issue);
  const skills = roleSkills(role, project, issue, {});
  const selection = selectRoleProfile({
    allowStrategy: false,
    issueProfileId: issue.agent_profile_id,
    profiles: listAgentProfiles(db),
    projectDefaultProfileId: project.default_agent_profile_id,
    projectProvider: project.provider,
    requiredSkillIntents: skills.required,
    role
  });
  return recommendationFor(project, issue, role, skills, selection);
}

function recommendationFor(
  project: Project,
  issue: Issue | null,
  role: AgentRole,
  skills: { recommended: string[]; required: string[] },
  selection: RoleProfileSelection
): AgentRecommendation {
  const profile = selection.profile;
  return {
    agent_role: role,
    approval_policy: profile?.approval_policy || project.approval_policy,
    issue_id: issue?.id ?? 0,
    model: profile?.model || project.model,
    profile_id: profile?.id ?? "",
    profile_name: profile?.name ?? "",
    project_id: project.id,
    provider: profile?.provider || project.provider,
    reason: selection.selection_reason,
    recommended_skill_intents: skills.recommended,
    reasoning_effort: profile?.reasoning_effort ?? "",
    required_skill_intents: skills.required,
    selection_reason: selection.selection_reason,
    sandbox: profile?.sandbox || project.sandbox,
    service_tier: profile?.service_tier || project.default_service_tier
  };
}

function roleSkills(
  role: AgentRole,
  project: Project,
  issue: Issue | null,
  input: AgentRecommendationInput
): { recommended: string[]; required: string[] } {
  const policy = parseSkillPolicy(project.default_skill_policy);
  return {
    required: mergeSkillIntents(policy.required, roleRequiredSkills(role), issue?.required_skill_intents, inputSkill(input, "required_skill_intents")),
    recommended: mergeSkillIntents(policy.recommended, issue?.recommended_skill_intents, inputSkill(input, "recommended_skill_intents"))
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
