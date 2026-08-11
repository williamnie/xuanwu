import type { RunnerDatabase } from "../db/database.ts";
import { listIssueEvents, recordIssueEvent } from "../db/repositories/issueEvents.ts";
import { createIssueRun } from "../db/repositories/issueRuns.ts";
import { getIssue, listIssueRuns, type Issue } from "../db/repositories/issues.ts";
import { getProject } from "../db/repositories/projects.ts";
import {
  assertCompletionCardIntegrity,
  type CompletionCard
} from "../domain/acceptance/completionCard.ts";
import { createHumanReviewRequest, readIssueDecisionProjection } from "../domain/review/humanReview.ts";
import type { EventBus } from "../events/bus.ts";
import { resolveExecutorSelection } from "../pi/agentOrchestration.ts";
import type { PiAcceptanceDecision } from "../pi/issueAcceptance.ts";
import {
  isExecutorProviderId,
  isProviderInterruptedError,
  type ExecutorProvider,
  type ExecutorProviderId
} from "../providers/types.ts";
import { applyPiSemanticIssueStatus } from "./piIssueLifecycle.ts";
import { recoverIssueWithProvider, runIssueWithProvider } from "./providerRuntime.ts";
import { reconcileProviderOutcome } from "./providerOutcome.ts";

export const PI_ACCEPTANCE_DECISION_EVENT = "issue.pi_acceptance_decision.v1";
export const PI_ACCEPTANCE_APPLIED_EVENT = "issue.pi_acceptance_applied.v1";
export const PI_HUMAN_ACCEPTANCE_HONORED_EVENT = "issue.pi_human_acceptance_honored.v1";
export const MAX_AUTOMATIC_FRESH_SESSION_RETRIES = 2;

export type PiAcceptanceApplicationRuntime = {
  bus?: Pick<EventBus, "publish">;
  database: RunnerDatabase;
  providers?: Partial<Record<ExecutorProviderId, ExecutorProvider>>;
};

export async function applyPiAcceptanceDecision(
  runtime: PiAcceptanceApplicationRuntime,
  card: CompletionCard,
  decision: PiAcceptanceDecision
): Promise<Issue> {
  assertCompletionCardIntegrity(card);
  const replay = getIssue(runtime.database, card.issue.id);
  if (replay?.status === "done" && applied(runtime.database, card.issue.id, card.fingerprint)) return replay;
  assertCurrentCard(runtime.database, card);
  const effectiveDecision = honorAcceptedDeliveryReview(runtime.database, card, decision);
  recordDecision(runtime.database, card, effectiveDecision);
  if (effectiveDecision.decision === "accept") return acceptIssue(runtime, card, effectiveDecision);
  if (effectiveDecision.decision === "needs_user") return requestUser(runtime, card, effectiveDecision);
  if (effectiveDecision.decision === "failed") return failIssue(runtime, card, effectiveDecision);
  if (effectiveDecision.decision === "retry") return retryInNewSession(runtime, card, effectiveDecision);
  return continueSameSession(runtime, card, effectiveDecision);
}

function honorAcceptedDeliveryReview(
  db: RunnerDatabase,
  card: CompletionCard,
  decision: PiAcceptanceDecision
): PiAcceptanceDecision {
  const review = card.human_review;
  if (!new Set<PiAcceptanceDecision["decision"]>([
    "continue_same_session",
    "needs_user",
    "retry"
  ]).has(decision.decision)
    || review?.action !== "accept"
    || review.request.kind !== "acceptance"
    || review.request.question === "") {
    return decision;
  }
  recordIssueEvent(db, card.issue.id, PI_HUMAN_ACCEPTANCE_HONORED_EVENT, {
    attempted_decision: decision,
    card_fingerprint: card.fingerprint,
    reason: decision.decision === "retry"
      ? "accepted delivery review forbids a fresh execution Session for the same stated criteria"
      : decision.decision === "continue_same_session"
        ? "accepted delivery review forbids continuing execution for the same stated criteria"
        : "accepted delivery review closes its stated human-only criteria",
    request_id: review.request_id,
    revision: review.review_revision,
    run_id: review.origin_run_id || card.run.id
  });
  return {
    confidence: decision.confidence,
    decision: "accept",
    evidence_refs: [...new Set([...decision.evidence_refs, `human-review:${review.request_id}`])],
    rationale: `用户已明确接受当前交付及该验收请求列出的取舍；不得因同一缺口重复请求确认、继续执行或启动新的执行 Session。${decision.rationale}`,
    unmet_requirements: []
  };
}

function acceptIssue(
  runtime: PiAcceptanceApplicationRuntime,
  card: CompletionCard,
  decision: PiAcceptanceDecision
): Issue {
  const db = runtime.database;
  const issue = mustGetIssue(db, card.issue.id);
  const write = applyPiSemanticIssueStatus(db, issue.id, {
    card_fingerprint: card.fingerprint,
    decision: decision.decision,
    reason: decision.rationale,
    run_id: card.run.id,
    status: "done"
  });
  recordIssueEvent(db, issue.id, PI_ACCEPTANCE_APPLIED_EVENT, {
    action: "accept",
    card_fingerprint: card.fingerprint,
    decision,
    from_status: issue.status,
    run_id: card.run.id,
    status: "done"
  });
  publishStatus(runtime, write);
  return write;
}

async function continueSameSession(
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
  const provider = runtime.providers?.[providerID];
  if (!provider?.recover || !provider.capabilities.includes("resume_session")) {
    return requestUser(runtime, card, {
      ...decision,
      decision: "needs_user",
      rationale: `Provider ${providerID} 当前不支持在原 Session 续跑。${decision.rationale}`
    });
  }
  const project = getProject(db, issue.project_id);
  if (!project) throw new Error(`Project ${issue.project_id} not found`);
  const newRun = db.transaction(() => {
    const created = createIssueRun(db, issue.id);
    recordIssueEvent(db, issue.id, PI_ACCEPTANCE_APPLIED_EVENT, {
      action: decision.decision,
      card_fingerprint: card.fingerprint,
      decision,
      new_run_id: created.id,
      resumed_from_run_id: previousRun.id,
      status: "in_progress"
    });
    return created;
  }).immediate();
  const selection = resolveExecutorSelection(db, project, issue);
  const serviceTier = issue.service_tier.trim() || project.default_service_tier.trim();
  try {
    const result = await recoverIssueWithProvider(provider, {
      agentProfileId: selection.profile_id,
      agentRole: selection.agent_role,
      approvalPolicy: selection.approval_policy || project.approval_policy,
      bus: runtime.bus,
      capabilitySummary: provider.capabilities.join(","),
      cwd: project.cwd,
      database: db,
      issueId: issue.id,
      model: selection.model,
      projectId: project.id,
      prompt: continuationPrompt(issue, decision),
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
    const message = safeError(error);
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

async function retryInNewSession(
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
  const provider = runtime.providers?.[providerID];
  if (!provider?.capabilities.includes("issue_execution")) {
    return requestUser(runtime, card, {
      ...decision,
      decision: "needs_user",
      rationale: `Provider ${providerID} 当前无法创建新的执行 Session。${decision.rationale}`
    });
  }
  const run = db.transaction(() => {
    const created = createIssueRun(db, issue.id);
    recordIssueEvent(db, issue.id, PI_ACCEPTANCE_APPLIED_EVENT, {
      action: "retry",
      card_fingerprint: card.fingerprint,
      decision,
      new_run_id: created.id,
      retried_from_run_id: card.run.id,
      status: "in_progress"
    });
    return created;
  }).immediate();
  const selection = resolveExecutorSelection(db, project, issue);
  const serviceTier = issue.service_tier.trim() || project.default_service_tier.trim();
  try {
    const result = await runIssueWithProvider(provider, {
      agentProfileId: selection.profile_id,
      agentRole: selection.agent_role,
      approvalPolicy: selection.approval_policy || project.approval_policy,
      bus: runtime.bus,
      capabilitySummary: provider.capabilities.join(","),
      cwd: project.cwd,
      database: db,
      issueId: issue.id,
      model: selection.model,
      projectId: project.id,
      prompt: retryPrompt(issue, decision),
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
      reportedOutcome: { outcome: "failed", reason: safeError(error) }
    });
  }
  return mustGetIssue(db, issue.id);
}

function requestUser(
  runtime: PiAcceptanceApplicationRuntime,
  card: CompletionCard,
  decision: PiAcceptanceDecision
): Issue {
  const issue = applyPiSemanticIssueStatus(runtime.database, card.issue.id, {
    card_fingerprint: card.fingerprint,
    decision: decision.decision,
    reason: decision.rationale,
    run_id: card.run.id,
    status: "needs_user"
  });
  createHumanReviewRequest(runtime.database, card.issue.id, {
    acceptance_summary: decision.evidence_refs,
    consequences: decision.unmet_requirements.join("；"),
    evidence_refs: [`completion-card:${card.fingerprint}`, ...decision.evidence_refs],
    kind: "acceptance",
    question: decision.rationale,
    recommendation: decision.follow_up_prompt || "请查看小结卡片并决定接受、要求调整或拒绝。"
  }, { bus: runtime.bus });
  recordIssueEvent(runtime.database, card.issue.id, PI_ACCEPTANCE_APPLIED_EVENT, {
    action: "needs_user",
    card_fingerprint: card.fingerprint,
    decision,
    run_id: card.run.id,
    status: "needs_user"
  });
  publishStatus(runtime, issue);
  return issue;
}

function failIssue(
  runtime: PiAcceptanceApplicationRuntime,
  card: CompletionCard,
  decision: PiAcceptanceDecision
): Issue {
  const issue = applyPiSemanticIssueStatus(runtime.database, card.issue.id, {
    card_fingerprint: card.fingerprint,
    decision: decision.decision,
    reason: decision.rationale,
    run_id: card.run.id,
    status: "failed"
  });
  recordIssueEvent(runtime.database, card.issue.id, PI_ACCEPTANCE_APPLIED_EVENT, {
    action: "failed",
    card_fingerprint: card.fingerprint,
    decision,
    run_id: card.run.id,
    status: "failed"
  });
  publishStatus(runtime, issue);
  return issue;
}

function assertCurrentCard(db: RunnerDatabase, card: CompletionCard): void {
  const issue = mustGetIssue(db, card.issue.id);
  if (issue.status !== "in_progress") {
    throw new Error(`PI acceptance requires in_progress; Issue is ${issue.status}`);
  }
  const run = listIssueRuns(db, issue.id).at(-1);
  if (!run || run.id !== card.run.id || run.ended_at === "") {
    throw new Error("PI acceptance completion card is stale for the latest canonical Run");
  }
  if (issue.updated_at !== card.issue.updated_at) {
    throw new Error("PI acceptance completion card is stale for the current Issue revision");
  }
  if (readIssueDecisionProjection(db, issue.id).owner !== "pi") {
    throw new Error("PI acceptance cannot bypass an open human review request");
  }
}

function recordDecision(db: RunnerDatabase, card: CompletionCard, decision: PiAcceptanceDecision): void {
  const exists = listIssueEvents(db, card.issue.id, {
    limit: 50,
    types: [PI_ACCEPTANCE_DECISION_EVENT]
  }).some((event) => cleanString(objectValue(parseJson(event.payload)).card_fingerprint) === card.fingerprint);
  if (exists) return;
  recordIssueEvent(db, card.issue.id, PI_ACCEPTANCE_DECISION_EVENT, {
    card_fingerprint: card.fingerprint,
    decision,
    issue_updated_at: card.issue.updated_at,
    run_id: card.run.id
  });
}

function applied(db: RunnerDatabase, issueID: number, fingerprint: string): boolean {
  return listIssueEvents(db, issueID, { limit: 50, types: [PI_ACCEPTANCE_APPLIED_EVENT] })
    .some((event) => cleanString(objectValue(parseJson(event.payload)).card_fingerprint) === fingerprint);
}

function continuationPrompt(issue: Issue, decision: PiAcceptanceDecision): string {
  return [
    `继续处理 Issue #${issue.id}：${issue.title}`,
    "",
    "这是 PI 对上一 Run 小结卡片的验收结论。必须在同一个 Provider Session 的新 Run/Turn 中继续，不得创建新的业务 Issue 或 Verifier Issue。",
    `验收动作：${decision.decision}`,
    `理由：${decision.rationale}`,
    decision.unmet_requirements.length > 0 ? `未满足项：${decision.unmet_requirements.join("；")}` : "",
    `具体后续：${decision.follow_up_prompt || "修复上述问题并补充最小充分的真实验证。"}`,
    "",
    "先读取当前工作区，避免重复已经成功的步骤。完成后报告改动文件、命令和退出码。Runner Host 负责最终状态写回。",
    "最终回复必须以 RUNNER_OUTCOME: completed、RUNNER_OUTCOME: failed | <reason> 或 RUNNER_OUTCOME: needs_user | <reason> 结尾。"
  ].filter(Boolean).join("\n");
}

function retryPrompt(issue: Issue, decision: PiAcceptanceDecision): string {
  return [
    `重新处理 Issue #${issue.id}：${issue.title}`,
    "",
    "PI 已确认原 Provider Session 无法可靠继续，因此这是同一个 Issue 的新 Session。不要创建新的业务 Issue 或 Verifier Issue。",
    `理由：${decision.rationale}`,
    decision.unmet_requirements.length > 0 ? `未满足项：${decision.unmet_requirements.join("；")}` : "",
    `具体后续：${decision.follow_up_prompt || "读取当前工作区，完成剩余工作并执行最小充分验证。"}`,
    "",
    "必须先读取当前工作区和已有改动，避免重复或覆盖已完成步骤。Runner Host 负责最终状态写回。",
    "最终回复必须以 RUNNER_OUTCOME: completed、RUNNER_OUTCOME: failed | <reason> 或 RUNNER_OUTCOME: needs_user | <reason> 结尾。"
  ].filter(Boolean).join("\n");
}

function publishStatus(runtime: PiAcceptanceApplicationRuntime, issue: Issue): void {
  runtime.bus?.publish({
    issueId: issue.id,
    payload: JSON.stringify({ status: issue.status }),
    projectId: issue.project_id,
    type: "issue.status_changed"
  });
}

function mustGetIssue(db: RunnerDatabase, issueID: number): Issue {
  const issue = getIssue(db, issueID);
  if (!issue) throw new Error(`Issue #${issueID} not found`);
  return issue;
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return {};
  }
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
