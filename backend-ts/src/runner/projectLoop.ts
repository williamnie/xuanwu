import {
  claimNextIssue,
  peekNextReadyIssue,
  peekNextTodoIssue
} from "../db/repositories/issueQueue.ts";
import { issueTimestamp } from "../db/repositories/issueCreate.ts";
import { listIssueEvents } from "../db/repositories/issueEvents.ts";
import { getProject } from "../db/repositories/projects.ts";
import { getIssue, listIssueRuns, type Issue } from "../db/repositories/issues.ts";
import type { Project } from "../db/repositories/projects.ts";
import type { RunnerDatabase } from "../db/database.ts";
import type { EventBus } from "../events/bus.ts";
import { runIssueWithProvider } from "./providerRuntime.ts";
import { issuePromptImages } from "./issuePromptImages.ts";
import { parseMcpPolicy } from "../mcp/policy.ts";
import { publicMcpRegistry } from "../mcp/registry.ts";
import { mergeSkillIntents, parseSkillPolicy } from "../skills/intents.ts";
import { listSkillRegistry } from "../skills/registry.ts";
import { resolveExecutorSelection, type AgentRecommendation } from "../pi/agentOrchestration.ts";
import {
  isExecutorProviderId,
  isProviderInterruptedError,
  type ExecutorProvider,
  type ExecutorProviderId,
  type ProviderRunResult
} from "../providers/types.ts";
import { reconcileProviderOutcome } from "./providerOutcome.ts";

export type ProjectLoopInput = {
  bus?: Pick<EventBus, "publish">;
  database: RunnerDatabase;
  now?: Date | string;
  onProjectSlotReleased?: (projectID: string) => void;
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
  const prompt = buildIssuePrompt(project, issue, input.database);
  try {
    const serviceTier = resolveServiceTier(issue, selection, project);
    const result = await runIssueWithProvider(provider, {
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
      model: selection.model,
      onProjectSlotReleased: input.onProjectSlotReleased,
      reasoningEffort: selection.reasoning_effort,
      approvalPolicy: selection.approval_policy || project.approval_policy,
      sandbox: selection.sandbox || project.sandbox,
      serviceTier: serviceTier.value,
      serviceTierSource: serviceTier.source,
      selectionReason: selection.selection_reason
    });
    await reconcileProviderOutcome({
      bus: input.bus,
      database: input.database,
      issueID: issue.id,
      issueRunID: claimedRunID,
      now: optionalDate(input.now),
      providerID: provider.id,
      providerRunID: result.runId
    });
    return result;
  } catch (error) {
    if (!isProviderInterruptedError(error) && !issueExecutionNoLongerCurrent(input.database, issue.id, claimedRunID)) {
      await reconcileProviderOutcome({
        bus: input.bus,
        database: input.database,
        issueID: issue.id,
        issueRunID: claimedRunID,
        now: optionalDate(input.now),
        providerID: provider.id,
        reportedOutcome: {
          outcome: "failed",
          reason: error instanceof Error ? error.message : String(error)
        }
      });
    }
    return { runId: "provider_terminal" };
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
    if (preferred) {
      assertProviderReady(preferred, project.id);
      return preferred;
    }
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
  const provider = isExecutorProviderId(providerID) ? providers[providerID] : undefined;
  void now;
  return Boolean(provider) && provider!.capabilities.includes("issue_execution") && providerReady(provider!);
}

function providerReady(provider: ExecutorProvider): boolean {
  return provider.runtimeStatus?.().ready !== false;
}

function assertProviderReady(provider: ExecutorProvider, projectID: string): void {
  const status = provider.runtimeStatus?.();
  if (status?.ready !== false) return;
  throw new Error(`project ${projectID} provider "${provider.id}" is not ready: ${status.reason || "configuration required"}`);
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

const CLOSED_ISSUE_STATUSES = new Set(["done", "failed", "cancelled", "needs_user"]);

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
  assertProviderReady(provider, project.id);
  return provider;
}

export function buildIssuePromptForTest(project: Project, issue: Issue, database?: RunnerDatabase): string {
  return buildIssuePrompt(project, issue, database);
}

function buildIssuePrompt(project: Project, issue: Issue, database?: RunnerDatabase): string {
  const title = issue.title.trim();
  const description = issue.description.trim();
  const base = description === "" || description === title
    ? title
    : [`# ${title}`, "", description].join("\n");
  return withRunnerContext(project, issue, [base, "", issueExecutionContext(issue)].join("\n"), database);
}

function issueExecutionContext(issue: Issue): string {
  return [
    "## Xuanwu execution context (authoritative)",
    `You are executing the existing, already claimed Issue #${issue.id}. The Runner and PI own its lifecycle.`,
    "- Do not create, deduplicate, enqueue, retry, cancel, delete, or change the status of this Issue, and do not stop its current Run through Xuanwu CLI/API calls.",
    "- An active `in_progress` state is expected. Issue-authored wording such as `keep triage`, `do not enqueue`, or `do not auto-start` describes the pre-dispatch planning state and is not a reason to undo this active Run.",
    "- Pre-dispatch state wording does not prove that substantive prerequisites such as credentials, budget, external authorization, or user-supplied choices are satisfied. If one is still missing, do not perform the gated action; report the exact blocker for PI.",
    "- End the final response with exactly one marker: `RUNNER_OUTCOME: completed`, `RUNNER_OUTCOME: failed | <reason>`, or `RUNNER_OUTCOME: needs_user | <reason>`. The Host will reconcile the Run and PI will decide the Issue status."
  ].join("\n");
}

function withRunnerContext(project: Project, issue: Issue, prompt: string, database?: RunnerDatabase): string {
  return withMcpRequirementContext(
    project,
    issue,
    withSkillIntentContext(project, issue, withGovernedRetryContext(database, issue, prompt))
  );
}

const SUPERVISOR_RETRY_EVENT = "issue.supervisor_retry";
const MAX_RETRY_CONTEXT_CHARS = 4_000;

function withGovernedRetryContext(database: RunnerDatabase | undefined, issue: Issue, prompt: string): string {
  const context = governedRetryContext(database, issue);
  if (!context) return prompt.trim();
  return [
    prompt.trim(),
    "",
    "## Governed retry context",
    "The Runner authorized this new attempt after Supervisor revalidation. The resolution below addresses the previous attempt's blocker. Apply it only within the original Issue goal and non-goals; it does not authorize unrelated expansion.",
    context.decisionID ? `Decision: ${context.decisionID}` : "",
    `Resolution: ${context.reason}`
  ].filter(Boolean).join("\n").trim();
}

function governedRetryContext(
  database: RunnerDatabase | undefined,
  issue: Issue
): { decisionID: string; reason: string } | null {
  if (!database) return null;
  const event = listIssueEvents(database, issue.id, { limit: 1, types: [SUPERVISOR_RETRY_EVENT] })[0];
  if (!event) return null;
  try {
    const payload = JSON.parse(event.payload) as Record<string, unknown>;
    const reason = boundedPromptText(payload.reason, MAX_RETRY_CONTEXT_CHARS);
    if (reason === "") return null;
    return {
      decisionID: boundedPromptText(payload.decision_id, 512),
      reason
    };
  } catch {
    return null;
  }
}

function boundedPromptText(value: unknown, limit: number): string {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, limit);
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

function optionalDate(value: Date | string | undefined): Date | undefined {
  if (value instanceof Date) return value;
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}
