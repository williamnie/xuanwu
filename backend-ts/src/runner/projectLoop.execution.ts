import { evaluateQueueCandidate } from "./queueEligibility.ts";
import { reserveNextIssue, peekNextReadyIssue, peekNextTodoIssue } from "../db/repositories/issueQueue.ts";
import { type Issue } from "../db/repositories/issues.ts";
import type { Project } from "../db/repositories/projects.ts";
import { runIssueWithProvider } from "./providerRuntime.ts";
import { issuePromptImages } from "./issuePromptImages.ts";
import { resolveExecutorSelection, type AgentRecommendation } from "../pi/runtime/agentOrchestration.ts";
import { isExecutorProviderId, isProviderInterruptedError, type ProviderRunResult } from "../providers/types.ts";
import { reconcileProviderOutcome } from "./providerOutcome.ts";
import { prepareReservedIssueRun } from "../domain/run/runPreparation.ts";
import { refreshSafeWorkspaceWaits } from "../domain/review/workspaceWait.ts";
import { cleanString } from "../util/values.ts";
import { providersForProjectCwd } from "../nodes/remoteExecution.ts";
import { isRemoteProjectCwd } from "../nodes/projectLocation.ts";
import type { ProjectLoopInput, ProjectLoopResult, ProjectLoopDecision } from "./projectLoop.model.ts";
import { mustGetProject, recordProjectLoopDecision, issueProviderAvailable, decision, issueProviderID, selectedProvider, issueExecutionNoLongerCurrent } from "./projectLoop.readiness.ts";
import { buildIssuePrompt, remoteSkillPackages, optionalDate } from "./projectLoop.prompt.ts";

export async function runProjectLoopOnce(loopInput: ProjectLoopInput): Promise<ProjectLoopResult> {
  const project = mustGetProject(loopInput.database, loopInput.projectId);
  const input = withProjectProviders(loopInput, project);
  const decision = projectLoopDecision(input, true);
  if (!decision.allowed) {
    recordProjectLoopDecision(input.database, decision);
    return { claimed: false };
  }
  await refreshSafeWorkspaceWaits(input.database, project.id);
  const claim = reserveNextIssue(input.database, project.id, (candidate) => (
    issueProviderAvailable(input.database, project, candidate, input.providers, input.now)
  ), input.now);
  if (!claim) return { claimed: false };
  const prepared = await prepareReservedIssueRun(input.database, claim.reservation);
  if (prepared.status !== "ready") return { claimed: false };
  const issue = claim.issue;
  recordProjectLoopDecision(input.database, { ...decision, issue });
  publishIssueStatus(input, issue);
  const run = await runClaimedIssue(input, project, issue, claim.reservation.run_id);
  return { claimed: true, issue, run };
}

export function projectLoopDecision(loopInput: ProjectLoopInput, forceOnce: boolean): ProjectLoopDecision {
  const project = mustGetProject(loopInput.database, loopInput.projectId);
  const input = withProjectProviders(loopInput, project);
  const firstQueued = peekNextTodoIssue(input.database, project.id);
  const firstReady = peekNextReadyIssue(input.database, project.id);
  const projectReasons = evaluateQueueCandidate({ project, forceOnce });
  if (projectReasons[0]?.code === "project_hold") {
    return decision(false, "project_holds", firstQueued, project.provider, "project_hold", `project:${project.id}`);
  }
  if (projectReasons.some((reason) => reason.code === "auto_run_off")) {
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

export async function runClaimedIssue(
  input: ProjectLoopInput,
  project: Project,
  issue: Issue,
  issueRunID: string
): Promise<ProviderRunResult> {
  const claimedRunID = issueRunID;
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
      issueRunId: claimedRunID,
      projectId: project.id,
      cwd: project.cwd,
      images: issuePromptImages(input.database, prompt),
      ...(isRemoteProjectCwd(project.cwd) ? { skillPackages: remoteSkillPackages(project, issue, input.database) } : {}),
      prompt,
      model: selection.model,
      onProjectSlotReleased: input.onProjectSlotReleased,
      reasoningEffort: selection.reasoning_effort,
      approvalPolicy: selection.approval_policy || project.approval_policy,
      executionPolicyRequest: selection.execution_policy,
      executionPolicyResolutionSource: selection.execution_policy_source,
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

/** 远程项目改用其节点上的 provider；节点离线时这些 provider 报告未就绪，任务排队等待。 */
export function withProjectProviders(input: ProjectLoopInput, project: Project): ProjectLoopInput {
  const providers = providersForProjectCwd(input.providers, project.cwd);
  return providers === input.providers ? input : { ...input, providers };
}

export function publishIssueStatus(input: ProjectLoopInput, issue: Issue): void {
  input.bus?.publish({
    issueId: issue.id,
    payload: JSON.stringify({ status: issue.status }),
    projectId: issue.project_id,
    type: "issue.status_changed"
  });
}

export type ResolvedServiceTier = { source: string; value: string };

export function resolveServiceTier(issue: Issue, selection: AgentRecommendation, project: Project): ResolvedServiceTier {
  const issueTier = cleanString(issue.service_tier);
  if (issueTier !== "") return { value: issueTier, source: "issue" };
  const profileTier = cleanString(selection.service_tier);
  if (selection.profile_id !== "" && profileTier !== "") return { value: profileTier, source: "agent_profile" };
  const projectTier = cleanString(project.default_service_tier);
  if (projectTier !== "") return { value: projectTier, source: "project" };
  return { value: "", source: "standard" };
}
