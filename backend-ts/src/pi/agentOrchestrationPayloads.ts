import type { Issue } from "../db/repositories/issues.ts";
import type { Project } from "../db/repositories/projects.ts";
import { mergeSkillIntents } from "../skills/intents.ts";
import type {
  AgentRecommendation,
  AgentRole,
  AgentWorkflowInput,
  NeedsUserEscalationInput
} from "./agentOrchestration.ts";

export function workflowIssuePayload(
  project: Project,
  target: Issue | null,
  role: AgentRole,
  recommendation: AgentRecommendation,
  input: AgentWorkflowInput
): Record<string, unknown> {
  const required = mergeSkillIntents(recommendation.required_skill_intents, input.required_skill_intents);
  const recommended = mergeSkillIntents(recommendation.recommended_skill_intents, input.recommended_skill_intents);
  return {
    agent_profile_id: recommendation.profile_id,
    description: workflowDescription(role, target, input, recommendation),
    goal_id: cleanString(input.goal_id),
    parent_issue_id: target?.id ?? 0,
    project_id: project.id,
    recommended_skill_intents: recommended,
    required_skill_intents: required,
    source_excerpt: sourceExcerpt(role, target, input),
    source_session_id: target?.codex_thread_id || target?.source_session_id || "",
    source_turn_id: target?.codex_turn_id || target?.source_turn_id || "",
    status: "triage",
    title: workflowTitle(role, target, input),
    workflow_snapshot_json: JSON.stringify(workflowSnapshot(role, target, recommendation, input, required, recommended))
  };
}

export function needsUserComment(input: NeedsUserEscalationInput): string {
  const action = cleanString(input.requested_action);
  return [
    `PI needs_user escalation: ${cleanString(input.reason)}`,
    action ? `Requested action: ${action}` : ""
  ].filter(Boolean).join("\n");
}

function workflowSnapshot(
  role: AgentRole,
  target: Issue | null,
  recommendation: AgentRecommendation,
  input: AgentWorkflowInput,
  required: string[],
  recommended: string[]
): Record<string, unknown> {
  return {
    agent_role: role,
    goal_id: cleanString(input.goal_id),
    parent_issue_id: target?.id ?? 0,
    recommended_profile_id: recommendation.profile_id,
    recommended_provider: recommendation.provider,
    report_type: cleanString(input.report_type),
    requested_by: "pi_manager",
    required_skill_intents: required,
    recommended_skill_intents: recommended
  };
}

function workflowDescription(
  role: AgentRole,
  target: Issue | null,
  input: AgentWorkflowInput,
  recommendation: AgentRecommendation
): string {
  return [
    `# ${roleLabel(role)} workflow`,
    target ? `Parent issue: #${target.id} ${target.title}` : "Parent issue: project-level workflow",
    `Role responsibility: ${roleResponsibility(role)}`,
    recommendation.profile_id
      ? `Recommended profile: ${recommendation.profile_id}`
      : `Recommended provider: ${recommendation.provider}`,
    cleanString(input.report_type) ? `Report type: ${cleanString(input.report_type)}` : "",
    cleanString(input.instructions) ? `Instructions: ${cleanString(input.instructions)}` : "",
    cleanString(input.verification_plan) ? `Verification plan: ${cleanString(input.verification_plan)}` : ""
  ].filter(Boolean).join("\n");
}

function workflowTitle(role: AgentRole, target: Issue | null, input: AgentWorkflowInput): string {
  const explicit = cleanString(input.title);
  if (explicit !== "") return explicit;
  const suffix = target ? `#${target.id} ${target.title}` : cleanString(input.report_type) || "project";
  return `${roleLabel(role)}: ${suffix}`;
}

function sourceExcerpt(role: AgentRole, target: Issue | null, input: AgentWorkflowInput): string {
  const parent = target ? `parent_issue_id=${target.id}` : "parent_issue_id=0";
  const goal = cleanString(input.goal_id) ? `goal_id=${cleanString(input.goal_id)}` : "";
  return [`agent_role=${role}`, parent, goal, cleanString(input.instructions)].filter(Boolean).join("; ");
}

function roleResponsibility(role: AgentRole): string {
  if (role === "verifier") return "verify completion evidence and acceptance criteria";
  if (role === "reviewer") return "review code or result quality before acceptance";
  if (role === "reporter") return "summarize daily, nightly, or failure status";
  return "execute the assigned runner issue";
}

function roleLabel(role: AgentRole): string {
  return role[0].toUpperCase() + role.slice(1);
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
