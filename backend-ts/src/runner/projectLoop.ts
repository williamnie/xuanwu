import { claimNextIssue } from "../db/repositories/issueQueue.ts";
import { getProject } from "../db/repositories/projects.ts";
import { getIssue, type Issue } from "../db/repositories/issues.ts";
import type { Project } from "../db/repositories/projects.ts";
import type { RunnerDatabase } from "../db/database.ts";
import type { EventBus } from "../events/bus.ts";
import { isExecutorProviderId } from "../providers/types.ts";
import { runIssueWithProvider } from "./providerRuntime.ts";
import { failIssueExecution } from "./statusGate.ts";
import { renderIssuePromptTemplate } from "./issuePromptTemplate.ts";
import { issuePromptImages } from "./issuePromptImages.ts";
import { parseMcpPolicy } from "../mcp/policy.ts";
import { publicMcpRegistry } from "../mcp/registry.ts";
import { mergeSkillIntents, parseSkillPolicy } from "../skills/intents.ts";
import { listSkillRegistry } from "../skills/registry.ts";
import { resolveExecutorSelection, type AgentRecommendation } from "../pi/agentOrchestration.ts";
import type { ExecutorProvider, ExecutorProviderId, ProviderRunResult } from "../providers/types.ts";

export type ProjectLoopInput = {
  bus?: Pick<EventBus, "publish">;
  database: RunnerDatabase;
  projectId: string;
  providers: Partial<Record<ExecutorProviderId, ExecutorProvider>>;
};

export type ProjectLoopResult =
  | { claimed: false }
  | { claimed: true; issue: Issue; run: ProviderRunResult };

export async function runProjectLoopOnce(input: ProjectLoopInput): Promise<ProjectLoopResult> {
  const project = mustGetProject(input.database, input.projectId);
  const issue = claimNextIssue(input.database, project.id);
  if (!issue) return { claimed: false };
  const run = await runClaimedIssue(input, project, issue);
  return { claimed: true, issue, run };
}

async function runClaimedIssue(
  input: ProjectLoopInput,
  project: Project,
  issue: Issue
): Promise<ProviderRunResult> {
  const selection = resolveExecutorSelection(input.database, project, issue);
  const provider = selectedProvider(project, selection, input.providers);
  const prompt = buildIssuePrompt(project, issue);
  try {
    const serviceTier = resolveServiceTier(issue, selection, project);
    return await runIssueWithProvider(provider, {
      agentProfileId: selection.profile_id,
      agentRole: selection.agent_role,
      bus: input.bus,
      capabilitySummary: provider.capabilities.join(","),
      database: input.database,
      issueId: issue.id,
      projectId: project.id,
      cwd: project.cwd,
      images: issuePromptImages(input.database, prompt),
      prompt,
      model: selection.model || project.model,
      reasoningEffort: selection.reasoning_effort,
      approvalPolicy: selection.approval_policy || project.approval_policy,
      sandbox: selection.sandbox || project.sandbox,
      serviceTier: serviceTier.value,
      serviceTierSource: serviceTier.source,
      selectionReason: selection.selection_reason
    });
  } catch (error) {
    if (issueAlreadyClosed(input.database, issue.id)) return { runId: "interrupted" };
    failIssueExecution(input.database, issue.id, error, provider.id);
    return { runId: "failed" };
  }
}

type ResolvedServiceTier = { source: string; value: string };

function resolveServiceTier(issue: Issue, selection: AgentRecommendation, project: Project): ResolvedServiceTier {
  const issueTier = cleanString(issue.service_tier);
  if (issueTier !== "") return { value: issueTier, source: "issue" };
  const profileTier = cleanString(selection.service_tier);
  if (selection.profile_id !== "" && profileTier !== "") return { value: profileTier, source: "agent_profile" };
  const projectTier = cleanString(project.default_service_tier);
  if (projectTier !== "") return { value: projectTier, source: "project" };
  return { value: "", source: "standard" };
}

function selectedProvider(
  project: Project,
  selection: AgentRecommendation,
  providers: ProjectLoopInput["providers"]
): ExecutorProvider {
  const preferred = isExecutorProviderId(selection.provider) ? providers[selection.provider] : undefined;
  if (preferred) return preferred;
  return projectProvider(project, providers);
}

function issueAlreadyClosed(db: RunnerDatabase, issueID: number): boolean {
  const issue = getIssue(db, issueID);
  return issue ? CLOSED_ISSUE_STATUSES.has(issue.status) : false;
}

const CLOSED_ISSUE_STATUSES = new Set(["done", "failed", "cancelled", "pending_verification"]);

function mustGetProject(db: RunnerDatabase, projectId: string): Project {
  const project = getProject(db, projectId);
  if (!project) throw new Error(`project ${projectId} not found`);
  return project;
}

function projectProvider(project: Project, providers: ProjectLoopInput["providers"]): ExecutorProvider {
  const providerID = project.provider.trim();
  if (!isExecutorProviderId(providerID)) throw new Error(`project ${project.id} provider "${providerID}" is not supported`);
  const provider = providers[providerID];
  if (!provider) throw new Error(`project ${project.id} provider "${providerID}" is not registered`);
  return provider;
}

export function buildIssuePromptForTest(project: Project, issue: Issue): string {
  return buildIssuePrompt(project, issue);
}

function buildIssuePrompt(project: Project, issue: Issue): string {
  const templated = issue.prompt_template.trim();
  if (templated !== "") {
    const rendered = renderIssuePromptTemplate(templated, { project, issue }).trim();
    if (rendered !== "") return withRunnerContext(project, issue, rendered);
  }
  return withRunnerContext(project, issue, issue.description.trim() || issue.title.trim());
}

function withRunnerContext(project: Project, issue: Issue, prompt: string): string {
  return withMcpRequirementContext(project, issue, withSkillIntentContext(project, issue, prompt));
}

function withSkillIntentContext(project: Project, issue: Issue, prompt: string): string {
  if (!hasSkillIntentContext(project, issue)) return prompt.trim();
  const policy = parseSkillPolicy(project.default_skill_policy);
  const metadata = matchedSkillMetadata(issue, policy);
  const skillContext = [
    "",
    "## Skill Intent Context",
    `Required skill intents: ${issue.required_skill_intents}`,
    `Recommended skill intents: ${issue.recommended_skill_intents}`,
    `Project default skill policy: ${JSON.stringify(policy)}`,
    metadata.length > 0 ? `Matched skills metadata: ${JSON.stringify(metadata)}` : ""
  ].filter((line) => line !== "").join("\n");
  return `${prompt.trim()}${skillContext}`.trim();
}

function matchedSkillMetadata(issue: Issue, policy: ReturnType<typeof parseSkillPolicy>) {
  const requested = new Set(mergeSkillIntents(
    issue.required_skill_intents,
    issue.recommended_skill_intents,
    policy.required,
    policy.recommended
  ));
  if (requested.size === 0) return [];
  return listSkillRegistry()
    .filter((skill) => requested.has(skill.id) || requested.has(skill.name))
    .map(skillSummary);
}

function hasSkillIntentContext(project: Project, issue: Issue): boolean {
  return issue.required_skill_intents !== "[]" || issue.recommended_skill_intents !== "[]" || project.default_skill_policy !== "{}";
}

function withMcpRequirementContext(project: Project, issue: Issue, prompt: string): string {
  if (!hasMcpRequirementContext(project, issue)) return prompt.trim();
  const mcpContext = [
    "",
    "## MCP Requirement Context",
    `Required MCP capabilities: ${issue.required_mcp_capabilities}`,
    `Recommended MCP capabilities: ${issue.recommended_mcp_capabilities}`,
    `Project default MCP policy: ${JSON.stringify(parseMcpPolicy(project.default_mcp_policy))}`,
    `Available MCP registry: ${JSON.stringify(publicMcpRegistry().slice(0, 24))}`
  ].join("\n");
  return `${prompt.trim()}${mcpContext}`.trim();
}

function hasMcpRequirementContext(project: Project, issue: Issue): boolean {
  return issue.required_mcp_capabilities !== "[]" || issue.recommended_mcp_capabilities !== "[]" || project.default_mcp_policy !== "{}";
}

function skillSummary(skill: ReturnType<typeof listSkillRegistry>[number]) {
  return { id: skill.id, name: skill.name, description: skill.description, risk_level: skill.risk_level, allowed_roles: skill.allowed_roles };
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
