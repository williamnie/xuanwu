import { claimNextIssue } from "../db/repositories/issueQueue.ts";
import { getProject } from "../db/repositories/projects.ts";
import type { Issue } from "../db/repositories/issues.ts";
import type { Project } from "../db/repositories/projects.ts";
import type { RunnerDatabase } from "../db/database.ts";
import { isExecutorProviderId } from "../providers/types.ts";
import { runIssueWithProvider } from "./providerRuntime.ts";
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
  const run = await runIssueWithProvider(provider, {
    database: input.database,
    issueId: issue.id,
    projectId: project.id,
    cwd: project.cwd,
    prompt: issuePrompt(issue),
    model: project.model,
    approvalPolicy: project.approval_policy,
    sandbox: project.sandbox
  });
  return { claimed: true, issue, run };
}

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

function issuePrompt(issue: Issue): string {
  return issue.description.trim() || issue.title.trim();
}
