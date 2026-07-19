import {
  claimNextIssue,
  hasDeferredProviderRuntime,
  peekNextReadyIssue,
  peekNextTodoIssue
} from "../db/repositories/issueQueue.ts";
import { issueTimestamp } from "../db/repositories/issueCreate.ts";
import { getProject } from "../db/repositories/projects.ts";
import { getIssue, listIssueRuns, type Issue } from "../db/repositories/issues.ts";
import type { Project } from "../db/repositories/projects.ts";
import type { RunnerDatabase } from "../db/database.ts";
import type { EventBus } from "../events/bus.ts";
import { isExecutorProviderId } from "../providers/types.ts";
import { runIssueWithProvider } from "./providerRuntime.ts";
import { failIssueExecution } from "./statusGate.ts";
import { deferIssueToPiAfterProviderFailure, isProviderInfraTransientFailure } from "./providerFailure.ts";
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
  now?: Date | string;
  projectId: string;
  providers: Partial<Record<ExecutorProviderId, ExecutorProvider>>;
};

export type ProjectLoopResult =
  | { claimed: false }
  | { claimed: true; issue: Issue; run: ProviderRunResult };

export type ProjectLoopDecision = {
  allowed: boolean;
  authority: string;
  issue: Issue | null;
  provider: string;
  reason: "dependency_blocker" | "no_work" | "project_hold" | "provider_runtime" | "ready" | "user_pause";
  scope: string;
};

export async function runProjectLoopOnce(input: ProjectLoopInput): Promise<ProjectLoopResult> {
  const project = mustGetProject(input.database, input.projectId);
  const decision = projectLoopDecision(input, true);
  if (!decision.allowed) {
    recordProjectLoopDecision(input.database, decision);
    return { claimed: false };
  }
  const issue = claimNextIssue(input.database, project.id, (candidate) => (
    issueProviderAvailable(input.database, project, candidate, input.providers, input.now)
  ), input.now);
  if (!issue) return { claimed: false };
  recordProjectLoopDecision(input.database, { ...decision, issue });
  publishIssueStatus(input, issue);
  const run = await runClaimedIssue(input, project, issue);
  return { claimed: true, issue, run };
}

export function projectLoopDecision(input: ProjectLoopInput, forceOnce: boolean): ProjectLoopDecision {
  const project = mustGetProject(input.database, input.projectId);
  const firstQueued = peekNextTodoIssue(input.database, project.id);
  const firstReady = peekNextReadyIssue(input.database, project.id);
  if (project.hold) {
    return decision(false, "project_holds", firstQueued, project.provider, "project_hold", `project:${project.id}`);
  }
  if (!forceOnce && project.auto_run !== 1) {
    return decision(false, "projects.auto_run", firstQueued, project.provider, "user_pause", `project:${project.id}`);
  }
  if (!firstReady) {
    return firstQueued
      ? decision(false, "work_relations(kind=depends_on)+issues.status+readiness-evidence-projection", firstQueued, "", "dependency_blocker", "dependency_subgraph")
      : decision(false, "issues.status", null, "", "no_work", `project:${project.id}`);
  }
  const runnable = peekNextReadyIssue(input.database, project.id, (issue) => (
    issueProviderAvailable(input.database, project, issue, input.providers, input.now)
  ));
  if (!runnable) {
    const provider = issueProviderID(input.database, project, firstReady);
    const authority = isExecutorProviderId(provider) && input.providers[provider] !== undefined
      ? "issue.provider_deferred"
      : "runner.providers";
    return decision(false, authority, firstReady, provider, "provider_runtime", `provider:${provider || "unknown"}`);
  }
  const provider = issueProviderID(input.database, project, runnable);
  return decision(true, "work_relations(kind=depends_on)+issues.status+readiness-evidence-projection", runnable, provider, "ready", `issue:${runnable.id}`);
}

async function runClaimedIssue(
  input: ProjectLoopInput,
  project: Project,
  issue: Issue
): Promise<ProviderRunResult> {
  const claimedRunID = openIssueRunID(input.database, issue.id);
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
    if (issueExecutionNoLongerCurrent(input.database, issue.id, claimedRunID)) return { runId: "interrupted" };
    if (isProviderInfraTransientFailure(error)) {
      deferIssueToPiAfterProviderFailure(input.database, issue.id, error, provider.id);
      const deferred = getIssue(input.database, issue.id);
      if (deferred) publishIssueStatus(input, deferred);
      return { runId: "provider_deferred" };
    }
    failIssueExecution(input.database, issue.id, error, provider.id);
    const failed = getIssue(input.database, issue.id);
    if (failed) publishIssueStatus(input, failed);
    return { runId: "failed" };
  }
}

function publishIssueStatus(input: ProjectLoopInput, issue: Issue): void {
  input.bus?.publish({
    issueId: issue.id,
    payload: JSON.stringify({ status: issue.status }),
    projectId: issue.project_id,
    type: "issue.status_changed"
  });
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
  if (isExecutorProviderId(selection.provider)) {
    const preferred = providers[selection.provider];
    if (preferred) return preferred;
    throw new Error(`project ${project.id} provider "${selection.provider}" is not registered`);
  }
  return projectProvider(project, providers);
}

function issueProviderAvailable(
  db: RunnerDatabase,
  project: Project,
  issue: Issue,
  providers: ProjectLoopInput["providers"],
  now: Date | string | undefined
): boolean {
  const providerID = issueProviderID(db, project, issue);
  return isExecutorProviderId(providerID) && providers[providerID] !== undefined &&
    !hasDeferredProviderRuntime(db, providerID, now ?? new Date());
}

function issueProviderID(db: RunnerDatabase, project: Project, issue: Issue): string {
  const selection = resolveExecutorSelection(db, project, issue);
  return isExecutorProviderId(selection.provider) ? selection.provider : project.provider.trim();
}

function decision(
  allowed: boolean,
  authority: string,
  issue: Issue | null,
  provider: string,
  reason: ProjectLoopDecision["reason"],
  scope: string
): ProjectLoopDecision {
  return { allowed, authority, issue, provider, reason, scope };
}

export function recordProjectLoopDecision(db: RunnerDatabase, input: ProjectLoopDecision): void {
  if (!input.issue) return;
  const payload = JSON.stringify({
    authority: input.authority,
    decision: input.allowed ? "continue" : "stop",
    provider: input.provider,
    reason: input.reason,
    scope: input.scope
  });
  const previous = db.sqlite.query<{ payload: string }, [number]>(`
    select payload from issue_events where issue_id=? and type='issue.runner_scope_decision'
    order by id desc limit 1
  `).get(input.issue.id)?.payload;
  if (!input.allowed && previous === payload) return;
  db.sqlite.run(
    `insert into issue_events (issue_id, type, payload, created_at) values (?, 'issue.runner_scope_decision', ?, ?)`,
    [input.issue.id, payload, issueTimestamp()]
  );
}

function issueExecutionNoLongerCurrent(db: RunnerDatabase, issueID: number, runID: string): boolean {
  const issue = getIssue(db, issueID);
  if (!issue || CLOSED_ISSUE_STATUSES.has(issue.status)) return true;
  const run = listIssueRuns(db, issueID).find((item) => item.id === runID);
  return !run || run.ended_at !== "";
}

function openIssueRunID(db: RunnerDatabase, issueID: number): string {
  return listIssueRuns(db, issueID).filter((run) => run.ended_at === "").at(-1)?.id ?? "";
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
  return withMcpRequirementContext(project, issue, withSkillIntentContext(project, issue, withGoalContract(issue, prompt)));
}

type GoalContractSection = {
  aliases: RegExp[];
  text: string;
};

function withGoalContract(issue: Issue, prompt: string): string {
  const base = prompt.trim();
  if (hasGoalContractHeading(base, [/^(goal contract|目标契约|终态契约)$/i])) return base;
  const sections = goalContractSections(issue).filter((section) => !hasGoalContractHeading(base, section.aliases));
  if (sections.length === 0) return base;
  const contract = ["", "## Goal Contract", ...sections.map((section) => section.text)].join("\n");
  return `${base}${contract}`.trim();
}

function goalContractSections(issue: Issue): GoalContractSection[] {
  const target = issue.title.trim() ? ` for "${issue.title.trim()}"` : ` for issue #${issue.id}`;
  return [
    {
      aliases: [/^(target outcome|outcome|goal|goals|objective|目标|终态|期望结果)$/i],
      text: `- Target outcome: Deliver the requested end state${target}; treat the issue description/template above as the source of truth.`
    },
    {
      aliases: [/^(required evidence|evidence|verification|validation|acceptance criteria|验收标准|验证|证据|最小验证)$/i],
      text: "- Required evidence: Before marking complete, run the smallest directly relevant verification and report commands, pass/fail result, and decisive evidence; explicitly write back the final status/outcome."
    },
    {
      aliases: [/^(constraints?|non-?goals?|constraints?\s*\/\s*non-?goals?|scope|out of scope|范围|约束|非目标|全局约束)$/i],
      text: "- Constraints / non-goals: Stay within this issue's stated scope and non-goals; do not change public schemas/contracts, shared state machines, provider adapters, root config, or unrelated files unless the user explicitly expands scope."
    },
    {
      aliases: [/^(stop policy|stop policy\s*\/\s*escalation|escalation|stop conditions?|blocked|blockers|停机策略|停止策略|升级|阻塞)$/i],
      text: "- Stop policy / escalation: Do not retry unboundedly; stop and report if the same failure repeats, required evidence cannot be produced, scope must expand, or schema/public-contract/shared-runtime changes are needed."
    }
  ];
}

function hasGoalContractHeading(prompt: string, aliases: RegExp[]): boolean {
  return prompt.split(/\r?\n/).some((line) => {
    const heading = normalizePromptHeading(line);
    return heading !== "" && aliases.some((alias) => alias.test(heading));
  });
}

function normalizePromptHeading(line: string): string {
  return line.trim()
    .replace(/^#{1,6}\s+/, "")
    .replace(/^[-*]\s+/, "")
    .replace(/^\d+[.)]\s+/, "")
    .replace(/[:：]\s*$/, "")
    .trim();
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
