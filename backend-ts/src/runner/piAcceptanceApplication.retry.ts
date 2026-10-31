import { listIssueEvents, recordIssueEvent } from "../db/repositories/issueEvents.ts";
import { insertIssueRunRecord } from "../db/repositories/issueRuns.ts";
import { prepareReservedIssueRun } from "../domain/run/runPreparation.ts";
import { listIssueRuns, type Issue } from "../db/repositories/issues.ts";
import { getProject } from "../db/repositories/projects.ts";
import { type CompletionCard } from "../domain/acceptance/completionCard.ts";
import { resolveExecutorSelection } from "../pi/runtime/agentOrchestration.ts";
import type { PiAcceptanceDecision } from "../pi/issues/issueAcceptance.ts";
import { isExecutorProviderId, isProviderInterruptedError } from "../providers/types.ts";
import { runIssueWithProvider } from "./providerRuntime.ts";
import { reconcileProviderOutcome } from "./providerOutcome.ts";
import { githubWorkExecutionContext } from "../integrations/github/issueWorkflow.ts";
import { cleanString, errorMessage, objectValue } from "../util/values.ts";
import { providersForProjectID } from "../nodes/remoteExecution.ts";
import { PI_ACCEPTANCE_APPLIED_EVENT, MAX_AUTOMATIC_FRESH_SESSION_RETRIES } from "./piAcceptanceApplication.model.ts";
import type { PiAcceptanceApplicationRuntime } from "./piAcceptanceApplication.model.ts";
import { mustGetIssue, parseJson, assertCurrentCard } from "./piAcceptanceApplication.audit.ts";
import { requestUser } from "./piAcceptanceApplication.outcomes.ts";
import { retryPrompt } from "./piAcceptanceApplication.prompts.ts";

export async function retryInNewSession(
  runtime: PiAcceptanceApplicationRuntime,
  card: CompletionCard,
  decision: PiAcceptanceDecision
): Promise<Issue> {
  const db = runtime.database;
  const issue = mustGetIssue(db, card.issue.id);
  const automaticRetries = listIssueEvents(db, issue.id, {
    limit: 500,
    types: [PI_ACCEPTANCE_APPLIED_EVENT]
  }).filter((event) => cleanString(objectValue(parseJson(event.payload)).action) === "retry").length;
  if (automaticRetries >= MAX_AUTOMATIC_FRESH_SESSION_RETRIES) {
    return requestUser(runtime, card, {
      ...decision,
      decision: "needs_user",
      rationale: `同一 Issue 已自动创建 ${automaticRetries} 个新执行 Session，已达到安全上限；为避免重复执行、并发修改和资源浪费，Runner 已停止继续重试。${decision.rationale}`,
      unmet_requirements: [
        ...decision.unmet_requirements,
        "需要人工检查现有 Session、工作区改动和失败原因后再决定继续或重试。"
      ]
    });
  }
  const project = getProject(db, issue.project_id);
  if (!project) throw new Error(`Project ${issue.project_id} not found`);
  const previousRun = listIssueRuns(db, issue.id).find((run) => run.id === card.run.id);
  const providerID = previousRun?.provider || project.provider;
  if (!isExecutorProviderId(providerID)) throw new Error(`unsupported provider for retry: ${providerID}`);
  // 远程项目的重试同样派回其节点。
  const provider = providersForProjectID(db, runtime.providers, issue.project_id)?.[providerID];
  if (!provider?.capabilities.includes("issue_execution")) {
    return requestUser(runtime, card, {
      ...decision,
      decision: "needs_user",
      rationale: `Provider ${providerID} 当前无法创建新的执行 Session。${decision.rationale}`
    });
  }
  const reservation = db.transaction(() => {
    assertCurrentCard(db, card);
    const created = insertIssueRunRecord(db, issue.id);
    recordIssueEvent(db, issue.id, PI_ACCEPTANCE_APPLIED_EVENT, {
      action: "retry",
      card_fingerprint: card.fingerprint,
      decision,
      new_run_id: created.run_id,
      retried_from_run_id: card.run.id,
      status: "in_progress"
    });
    return created;
  }).immediate();
  const preparation = await prepareReservedIssueRun(db, reservation);
  if (preparation.status !== "ready") throw new Error("Run preparation claim was invalidated before provider retry");
  const run = preparation.run;
  const selection = resolveExecutorSelection(db, project, issue);
  const serviceTier = issue.service_tier.trim() || project.default_service_tier.trim();
  try {
    const result = await runIssueWithProvider(provider, {
      agentProfileId: selection.profile_id,
      agentRole: selection.agent_role,
      approvalPolicy: selection.approval_policy || project.approval_policy,
      executionPolicyRequest: selection.execution_policy,
      executionPolicyResolutionSource: selection.execution_policy_source,
      bus: runtime.bus,
      capabilitySummary: provider.capabilities.join(","),
      cwd: project.cwd,
      database: db,
      issueId: issue.id,
      issueRunId: run.id,
      model: selection.model,
      projectId: project.id,
      prompt: [retryPrompt(issue, decision, card.human_review), githubWorkExecutionContext(db, issue.id)].filter(Boolean).join("\n"),
      reasoningEffort: selection.reasoning_effort,
      sandbox: selection.sandbox || project.sandbox,
      selectionReason: selection.selection_reason,
      serviceTier,
      serviceTierSource: issue.service_tier.trim() ? "issue" : serviceTier ? "project" : "standard"
    });
    await reconcileProviderOutcome({
      bus: runtime.bus,
      database: db,
      issueID: issue.id,
      issueRunID: run.id,
      providerID,
      providerRunID: result.runId
    });
  } catch (error) {
    if (!isProviderInterruptedError(error)) await reconcileProviderOutcome({
      bus: runtime.bus,
      database: db,
      issueID: issue.id,
      issueRunID: run.id,
      providerID,
      reportedOutcome: { outcome: "failed", reason: errorMessage(error) }
    });
  }
  return mustGetIssue(db, issue.id);
}
