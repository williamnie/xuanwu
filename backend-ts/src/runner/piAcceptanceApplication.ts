import { safelyRequestMemoryReflection } from "../pi/memoryReflectionQueue.ts";
import type { RunnerDatabase } from "../db/database.ts";
import { listIssueEvents, recordIssueEvent } from "../db/repositories/issueEvents.ts";
import { insertIssueRunRecord } from "../db/repositories/issueRuns.ts";
import { prepareReservedIssueRun } from "../domain/run/runPreparation.ts";
import { getIssue, listIssueRuns, type Issue } from "../db/repositories/issues.ts";
import { getProject } from "../db/repositories/projects.ts";
import {
  assertCompletionCardIntegrity,
  recordIssueCompletionCard,
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
import { prepareAcceptedDelivery, ACCEPTED_DELIVERY_SOURCE } from "../domain/handoff/acceptedDelivery.ts";
import { recordEvidenceRecords } from "../db/repositories/evidence.ts";
import { recordHandoffDelivery } from "../notifications/handoffNotifier.ts";
import { githubWorkAcceptanceProblem, githubWorkExecutionContext } from "../integrations/github/issueWorkflow.ts";
import { assertPriorEvidenceReferences, assertPriorExecutionEvidenceFresh, assertPriorExecutionEvidenceLedgerFresh } from "../domain/acceptance/priorExecutionEvidence.ts";
import { issueExecutionContext } from "../domain/work/issueExecutionAuthority.ts";

export const PI_ACCEPTANCE_DECISION_EVENT = "issue.pi_acceptance_decision.v1";
export const PI_ACCEPTANCE_APPLIED_EVENT = "issue.pi_acceptance_applied.v1";
export const PI_CONTINUATION_PROGRESS_EVENT = "issue.pi_continuation_progress.v1";
export const PI_HUMAN_ACCEPTANCE_HONORED_EVENT = "issue.pi_human_acceptance_honored.v1";
export const MAX_AUTOMATIC_FRESH_SESSION_RETRIES = 2;
export const MAX_CONSECUTIVE_NO_PROGRESS_CONTINUATIONS = 3;

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
  if (replay?.status === "done" && applied(runtime.database, card.issue.id, card.fingerprint)) {
    safelyRequestMemoryReflection(runtime.database, card.issue.id);
    return replay;
  }
  assertCurrentCard(runtime.database, card);
  assertPriorEvidenceReferences(card, decision);
  let effectiveDecision = honorAcceptedDeliveryReview(runtime.database, card, decision);
  if (effectiveDecision.decision === "accept") await assertPriorExecutionEvidenceFresh(runtime.database, card);
  if (effectiveDecision.decision === "accept" && !(card.human_review?.action === "accept" && card.human_review.request.kind === "acceptance")) {
    const problem = githubWorkAcceptanceProblem(runtime.database, card);
    if (problem) {
      const answers = listIssueEvents(runtime.database, card.issue.id, { types: ["issue.human_review_answered.v1"], limit: 20 });
      const latestApproval = [...answers].reverse().find(event => JSON.parse(event.payload).action === "accept");
      // 新的有效人工回答允许再做有界续跑；同一回答不能在后续每个 Run 重置预算。
      const priorFailures = listIssueEvents(runtime.database, card.issue.id, {
        types: ["github.acceptance_contract_failed.v1"], limit: 20, afterID: latestApproval?.id ?? 0
      });
      const runIDs = new Set(priorFailures.map(event => JSON.parse(event.payload).run_id));
      if (!runIDs.has(card.run.id)) recordIssueEvent(runtime.database, card.issue.id, "github.acceptance_contract_failed.v1", { run_id: card.run.id, problem });
      effectiveDecision = { ...effectiveDecision,
        decision: runIDs.size >= 2 ? "needs_user" : "continue_same_session", human_review_kind: "decision",
        rationale: runIDs.size >= 2 ? `交付报告与运行事实连续无法关联，已停止重复执行；需要检查报告或集成观测数据。${problem}` : problem,
        follow_up_prompt: `${problem} 仅 prior_evidence 中 reusable 且输入/环境覆盖范围已确认的原始命令可复用；若只是报告字段缺失，不重复执行这些命令。revalidation_required 按 reasons 选择必要补验；revalidation_commands 是来源索引，不得自动重放修改或外部副作用。`, unmet_requirements: [problem] };
    }
  }
  if (effectiveDecision.decision === "accept") return acceptIssue(runtime, card, effectiveDecision);
  recordDecision(runtime.database, card, effectiveDecision);
  if (effectiveDecision.decision === "needs_user") return requestUser(runtime, card, effectiveDecision);
  if (effectiveDecision.decision === "failed") return failIssue(runtime, card, effectiveDecision);
  if (effectiveDecision.decision === "retry") return retryInNewSession(runtime, card, effectiveDecision);
  const continuation = recordContinuationProgress(runtime.database, card, effectiveDecision);
  if (continuation.noProgressStreak >= MAX_CONSECUTIVE_NO_PROGRESS_CONTINUATIONS) {
    return requestUser(runtime, card, {
      ...effectiveDecision,
      decision: "needs_user",
      human_review_kind: "decision",
      rationale: `连续 ${continuation.noProgressStreak} 个 Run 没有实质进展，Runner 已暂停自动 continue，避免原地循环和持续消耗资源。${effectiveDecision.rationale}`,
      unmet_requirements: [
        ...effectiveDecision.unmet_requirements,
        "需要人工检查当前 Provider Session，并决定继续、调整提示词、切换模型或终止。"
      ]
    });
  }
  return continueSameSession(runtime, card, effectiveDecision);
}

type ContinuationProgress = {
  noProgressStreak: number;
};

function recordContinuationProgress(
  db: RunnerDatabase,
  card: CompletionCard,
  decision: PiAcceptanceDecision
): ContinuationProgress {
  const events = listIssueEvents(db, card.issue.id, {
    limit: 500,
    types: [PI_CONTINUATION_PROGRESS_EVENT]
  });
  const existing = events.map((event) => ({ event, payload: objectValue(parseJson(event.payload)) }))
    .find(({ payload }) => cleanString(payload.card_fingerprint) === card.fingerprint);
  if (existing) return { noProgressStreak: nonNegativeInteger(existing.payload.no_progress_streak) };

  const previous = events.at(-1);
  const previousPayload = objectValue(parseJson(previous?.payload ?? ""));
  const sameSession = cleanString(previousPayload.provider_session_id) !== ""
    && cleanString(previousPayload.provider_session_id) === card.run.provider_session_id;
  const humanIntervened = card.human_review !== null
    && Date.parse(card.human_review.answered_at) > Date.parse(previous?.created_at ?? "");
  const priorStreak = sameSession && !humanIntervened
    ? nonNegativeInteger(previousPayload.no_progress_streak)
    : 0;
  const noProgressStreak = decision.progress.made_progress ? 0 : priorStreak + 1;
  recordIssueEvent(db, card.issue.id, PI_CONTINUATION_PROGRESS_EVENT, {
    card_fingerprint: card.fingerprint,
    evidence_refs: decision.progress.evidence_refs,
    made_progress: decision.progress.made_progress,
    no_progress_streak: noProgressStreak,
    progress_summary: decision.progress.summary,
    provider_session_id: card.run.provider_session_id,
    run_id: card.run.id
  });
  return { noProgressStreak };
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
    progress: decision.progress,
    rationale: `用户已明确接受当前交付及该验收请求列出的取舍；不得因同一缺口重复请求确认、继续执行或启动新的执行 Session。${decision.rationale}`,
    unmet_requirements: []
  };
}

async function acceptIssue(
  runtime: PiAcceptanceApplicationRuntime,
  card: CompletionCard,
  decision: PiAcceptanceDecision
): Promise<Issue> {
  const db = runtime.database;
  // Git 只读观察在事务外准备；事务内再次校验版本，原子保存终态与交付账本。
  const delivery = await prepareAcceptedDelivery(db, card, decision);
  await assertPriorExecutionEvidenceFresh(db, card);
  const result = db.transaction(() => {
    const current = mustGetIssue(db, card.issue.id);
    if (current.status === "done" && applied(db, current.id, card.fingerprint)) return { issue: current, notification: null };
    assertCurrentCard(db, card);
    assertPriorExecutionEvidenceLedgerFresh(db, card);
    recordDecision(db, card, decision);
    recordIssueCompletionCard(db, card, ACCEPTED_DELIVERY_SOURCE);
    recordEvidenceRecords(db, card.issue.id, delivery.evidence, { recorded_at: delivery.recorded_at, source: ACCEPTED_DELIVERY_SOURCE });
    const receipt = recordHandoffDelivery({ database: db, issue_id: card.issue.id, handoff: delivery.handoff,
      recorded_at: delivery.recorded_at, source: ACCEPTED_DELIVERY_SOURCE });
    const issue = applyPiSemanticIssueStatus(db, card.issue.id, {
      card_fingerprint: card.fingerprint, decision: decision.decision, reason: decision.rationale,
      run_id: card.run.id, status: "done"
    });
    recordIssueEvent(db, issue.id, PI_ACCEPTANCE_APPLIED_EVENT, {
      action: "accept", card_fingerprint: card.fingerprint, decision,
      from_status: current.status, run_id: card.run.id, status: "done"
    });
    return { issue, notification: receipt.notification };
  }).immediate();
  const write = result.issue;
  safelyRequestMemoryReflection(db, write.id);
  if (result.notification) runtime.bus?.publish({ issueId: write.id, projectId: write.project_id,
    type: "handoff.notification", status: delivery.handoff.status, payload: result.notification.payload });
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
    // 缺少结构化类型时按普通决策处理，绝不能把补充信息或授权误当成接受当前交付。
    kind: decision.human_review_kind ?? "decision",
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
  const issue = runtime.database.transaction(() => {
    const failed = applyPiSemanticIssueStatus(runtime.database, card.issue.id, {
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
    return failed;
  }).immediate();
  safelyRequestMemoryReflection(runtime.database, issue.id);
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

function continuationPrompt(
  issue: Issue,
  decision: PiAcceptanceDecision,
  humanReview: CompletionCard["human_review"]
): string {
  return [
    `继续处理 Issue #${issue.id}：${issue.title}`,
    "",
    "原始 Issue 目标、验收标准与限制（结合下方已认证人类决定解释）：",
    issue.description.trim() || issue.title,
    "",
    "这是 PI 对上一 Run 小结卡片的验收结论。必须在同一个 Provider Session 的新 Run/Turn 中继续，不得创建新的业务 Issue 或 Verifier Issue。",
    humanReviewContext(humanReview),
    `验收动作：${decision.decision}`,
    `理由：${decision.rationale}`,
    decision.unmet_requirements.length > 0 ? `未满足项：${decision.unmet_requirements.join("；")}` : "",
    `具体后续：${decision.follow_up_prompt || "修复上述问题并补充最小充分的真实验证。"}`,
    "",
    issueExecutionContext(issue.id),
    "先读取当前工作区，避免重复已经成功的步骤。完成后报告改动文件、命令和退出码。Runner Host 负责最终状态写回。",
    "已满足 Issue 目标时使用 completed，包括不需要代码或工具的回答与解释。只有确实缺少新的用户输入、授权、凭据或决策时才使用 needs_user；不要因为任务是对话或没有仓库改动而使用 needs_user。",
    "最终回复必须以 RUNNER_OUTCOME: completed、RUNNER_OUTCOME: failed | <reason> 或 RUNNER_OUTCOME: needs_user | <reason> 结尾。"
  ].filter(Boolean).join("\n");
}

function retryPrompt(issue: Issue, decision: PiAcceptanceDecision, humanReview: CompletionCard["human_review"]): string {
  return [
    `重新处理 Issue #${issue.id}：${issue.title}`,
    "",
    "原始 Issue 目标、验收标准与限制（结合下方已认证人类决定解释）：",
    issue.description.trim() || issue.title,
    "",
    "PI 已确认原 Provider Session 无法可靠继续，因此这是同一个 Issue 的新 Session。不要创建新的业务 Issue 或 Verifier Issue。",
    humanReviewContext(humanReview),
    `理由：${decision.rationale}`,
    decision.unmet_requirements.length > 0 ? `未满足项：${decision.unmet_requirements.join("；")}` : "",
    `具体后续：${decision.follow_up_prompt || "读取当前工作区，完成剩余工作并执行最小充分验证。"}`,
    "",
    issueExecutionContext(issue.id),
    "必须先读取当前工作区和已有改动，避免重复或覆盖已完成步骤。Runner Host 负责最终状态写回。",
    "已满足 Issue 目标时使用 completed，包括不需要代码或工具的回答与解释。只有确实缺少新的用户输入、授权、凭据或决策时才使用 needs_user；不要因为任务是对话或没有仓库改动而使用 needs_user。",
    "最终回复必须以 RUNNER_OUTCOME: completed、RUNNER_OUTCOME: failed | <reason> 或 RUNNER_OUTCOME: needs_user | <reason> 结尾。"
  ].filter(Boolean).join("\n");
}

function humanReviewContext(review: CompletionCard["human_review"]): string {
  if (!review) return "";
  return [
    `已认证的人类回复类型：${review.request.kind}`,
    `原人类问题：${review.request.question}`,
    `已认证的人类回复动作：${review.action}`,
    review.comment ? `已认证的人类回复：${review.comment}` : ""
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

function nonNegativeInteger(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
