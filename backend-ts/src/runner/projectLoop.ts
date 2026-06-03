import { claimNextIssue } from "../db/repositories/issueQueue.ts";
import { getProject } from "../db/repositories/projects.ts";
import { getIssue, type Issue } from "../db/repositories/issues.ts";
import type { Project } from "../db/repositories/projects.ts";
import type { RunnerDatabase } from "../db/database.ts";
import { isExecutorProviderId } from "../providers/types.ts";
import { runIssueWithProvider } from "./providerRuntime.ts";
import { failIssueExecution } from "./statusGate.ts";
import { renderIssuePromptTemplate } from "./issuePromptTemplate.ts";
import { parseSkillPolicy } from "../skills/intents.ts";
import { listSkillRegistry } from "../skills/registry.ts";
import type { ExecutorProvider, ExecutorProviderId, ProviderRunResult } from "../providers/types.ts";

export type ProjectLoopInput = {
  database: RunnerDatabase;
  projectId: string;
  providers: Partial<Record<ExecutorProviderId, ExecutorProvider>>;
};

export type ProjectLoopResult =
  | { claimed: false }
  | { claimed: true; issue: Issue; run: ProviderRunResult };

export async function runProjectLoopOnce(input: ProjectLoopInput): Promise<ProjectLoopResult> {
  const project = mustGetProject(input.database, input.projectId);
  const provider = projectProvider(project, input.providers);
  const issue = claimNextIssue(input.database, project.id);
  if (!issue) return { claimed: false };
  const run = await runClaimedIssue(input, project, provider, issue);
  return { claimed: true, issue, run };
}

async function runClaimedIssue(
  input: ProjectLoopInput,
  project: Project,
  provider: ExecutorProvider,
  issue: Issue
): Promise<ProviderRunResult> {
  try {
    return await runIssueWithProvider(provider, {
      database: input.database,
      issueId: issue.id,
      projectId: project.id,
      cwd: project.cwd,
      prompt: issuePrompt(project, issue),
      model: project.model,
      approvalPolicy: project.approval_policy,
      sandbox: project.sandbox
    });
  } catch (error) {
    if (issueAlreadyClosed(input.database, issue.id)) return { runId: "interrupted" };
    failIssueExecution(input.database, issue.id, error, provider.id);
    return { runId: "failed" };
  }
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

function issuePrompt(project: Project, issue: Issue): string {
  const templated = issue.prompt_template.trim();
  if (templated !== "") {
    const rendered = renderIssuePromptTemplate(templated, { project, issue }).trim();
    if (rendered !== "") return withSkillIntentContext(project, issue, rendered);
  }
  return withSkillIntentContext(project, issue, issue.description.trim() || issue.title.trim());
}

function withSkillIntentContext(project: Project, issue: Issue, prompt: string): string {
  if (!hasSkillIntentContext(project, issue)) return prompt.trim();
  const skillContext = [
    "",
    "## Skill Intent Context",
    `Required skill intents: ${issue.required_skill_intents}`,
    `Recommended skill intents: ${issue.recommended_skill_intents}`,
    `Project default skill policy: ${JSON.stringify(parseSkillPolicy(project.default_skill_policy))}`,
    `Available skills metadata: ${JSON.stringify(listSkillRegistry().slice(0, 24).map(skillSummary))}`
  ].join("\n");
  return `${prompt.trim()}${skillContext}`.trim();
}

function hasSkillIntentContext(project: Project, issue: Issue): boolean {
  return issue.required_skill_intents !== "[]" || issue.recommended_skill_intents !== "[]" || project.default_skill_policy !== "{}";
}

function skillSummary(skill: ReturnType<typeof listSkillRegistry>[number]) {
  return { id: skill.id, name: skill.name, description: skill.description, risk_level: skill.risk_level, allowed_roles: skill.allowed_roles };
}
