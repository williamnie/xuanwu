import { recordIssueEvent } from "../db/repositories/issueEvents.ts";
import { insertIssueRunRecord } from "../db/repositories/issueRuns.ts";
import { prepareReservedIssueRun } from "../domain/run/runPreparation.ts";
import { listIssueRuns, type Issue } from "../db/repositories/issues.ts";
import { getProject } from "../db/repositories/projects.ts";
import { type CompletionCard } from "../domain/acceptance/completionCard.ts";
import { resolveExecutorSelection } from "../pi/runtime/agentOrchestration.ts";
import type { PiAcceptanceDecision } from "../pi/issues/issueAcceptance.ts";
import { isExecutorProviderId, isProviderInterruptedError } from "../providers/types.ts";
import { recoverIssueWithProvider } from "./providerRuntime.ts";
import { reconcileProviderOutcome } from "./providerOutcome.ts";
import { githubWorkExecutionContext } from "../integrations/github/issueWorkflow.ts";
import { errorMessage } from "../util/values.ts";
import { providersForProjectID } from "../nodes/remoteExecution.ts";
import { PI_ACCEPTANCE_APPLIED_EVENT } from "./piAcceptanceApplication.model.ts";
import type { PiAcceptanceApplicationRuntime } from "./piAcceptanceApplication.model.ts";
import { mustGetIssue, assertCurrentCard } from "./piAcceptanceApplication.audit.ts";
import { requestUser } from "./piAcceptanceApplication.outcomes.ts";
import { continuationPrompt } from "./piAcceptanceApplication.prompts.ts";

export async function continueSameSession(
  runtime: PiAcceptanceApplicationRuntime,
  card: CompletionCard,
  decision: PiAcceptanceDecision
): Promise<Issue> {
  const db = runtime.database;
  const issue = mustGetIssue(db, card.issue.id);
  const previousRun = listIssueRuns(db, issue.id).find((run) => run.id === card.run.id);
  if (!previousRun || previousRun.provider_session_id === "") {
    return requestUser(runtime, card, {
      ...decision,
      decision: "needs_user",
      rationale: `无法继续原 Session：当前 Run 没有可恢复的 provider_session_id。${decision.rationale}`
    });
  }
  const providerID = previousRun.provider;
  if (!isExecutorProviderId(providerID)) throw new Error(`unsupported provider for same-session continuation: ${providerID}`);
  // 远程项目在其节点上续跑。
  const provider = providersForProjectID(db, runtime.providers, issue.project_id)?.[providerID];
  if (!provider?.recover || !provider.capabilities.includes("resume_session")) {
    return requestUser(runtime, card, {
      ...decision,
      decision: "needs_user",
      rationale: `Provider ${providerID} 当前不支持在原 Session 续跑。${decision.rationale}`
    });
  }
  const project = getProject(db, issue.project_id);
  if (!project) throw new Error(`Project ${issue.project_id} not found`);
  const reservation = db.transaction(() => {
    assertCurrentCard(db, card);
    const created = insertIssueRunRecord(db, issue.id);
    recordIssueEvent(db, issue.id, PI_ACCEPTANCE_APPLIED_EVENT, {
      action: decision.decision,
      card_fingerprint: card.fingerprint,
      decision,
      new_run_id: created.run_id,
      resumed_from_run_id: previousRun.id,
      status: "in_progress"
    });
    return created;
  }).immediate();
  const preparation = await prepareReservedIssueRun(db, reservation);
  if (preparation.status !== "ready") throw new Error("Run preparation claim was invalidated before provider recovery");
  const newRun = preparation.run;
  const selection = resolveExecutorSelection(db, project, issue);
  const serviceTier = issue.service_tier.trim() || project.default_service_tier.trim();
  try {
    const result = await recoverIssueWithProvider(provider, {
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
      issueRunId: newRun.id,
      model: selection.model,
      projectId: project.id,
      prompt: [continuationPrompt(issue, decision, card.human_review), githubWorkExecutionContext(db, issue.id)].filter(Boolean).join("\n"),
      reasoningEffort: selection.reasoning_effort,
      sandbox: selection.sandbox || project.sandbox,
      selectionReason: selection.selection_reason,
      serviceTier,
      serviceTierSource: issue.service_tier.trim() ? "issue" : serviceTier ? "project" : "standard",
      session: {
        provider: providerID,
        sessionId: previousRun.provider_session_id,
        ...(previousRun.provider_turn_id ? { turnId: previousRun.provider_turn_id } : {})
      }
    });
    await reconcileProviderOutcome({
      bus: runtime.bus,
      database: db,
      issueID: issue.id,
      issueRunID: newRun.id,
      providerID,
      providerRunID: result.runId
    });
    return mustGetIssue(db, issue.id);
  } catch (error) {
    if (isProviderInterruptedError(error)) return mustGetIssue(db, issue.id);
    const message = errorMessage(error);
    recordIssueEvent(db, issue.id, "issue.pi_acceptance_continuation_failed.v1", {
      card_fingerprint: card.fingerprint,
      error: message,
      run_id: newRun.id
    });
    await reconcileProviderOutcome({
      bus: runtime.bus,
      database: db,
      issueID: issue.id,
      issueRunID: newRun.id,
      providerID,
      reportedOutcome: { outcome: "failed", reason: message }
    });
    return mustGetIssue(db, issue.id);
  }
}
