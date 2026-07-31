import type { RunnerDatabase } from "../db/database.ts";
import { recordEvidenceRecords } from "../db/repositories/evidence.ts";
import { listStoredHandoffs } from "../db/repositories/handoffs.ts";
import { listIssueEvents, recordIssueEvent } from "../db/repositories/issueEvents.ts";
import { createIssueRun } from "../db/repositories/issueRuns.ts";
import { getIssue, listIssueRuns, type Issue } from "../db/repositories/issues.ts";
import { getProject } from "../db/repositories/projects.ts";
import { updateIssue } from "../db/repositories/issueUpdate.ts";
import {
  assertCompletionCardIntegrity,
  type CompletionCard
} from "../domain/acceptance/completionCard.ts";
import type { EvidenceRecord } from "../domain/evidence/contracts.ts";
import { makeRunAttemptID } from "../domain/run/contracts.ts";
import { evaluateWorkTransition, type WorkAcceptanceEvidence, type WorkTransitionAudit } from "../domain/work/contracts.ts";
import { projectIssueAsWork } from "../domain/work/issueAdapter.ts";
import { createHumanReviewRequest, readIssueVerificationProjection } from "../domain/review/humanReview.ts";
import type { EventBus } from "../events/bus.ts";
import { resolveExecutorSelection } from "../pi/agentOrchestration.ts";
import type { PiAcceptanceDecision } from "../pi/issueAcceptance.ts";
import {
  isExecutorProviderId,
  type ExecutorProvider,
  type ExecutorProviderId
} from "../providers/types.ts";
import { makeDomainID } from "../xuanwu/coreDomainContracts.ts";
import { recoverIssueWithProvider } from "./providerRuntime.ts";

export const PI_ACCEPTANCE_DECISION_EVENT = "issue.pi_acceptance_decision.v1";
export const PI_ACCEPTANCE_APPLIED_EVENT = "issue.pi_acceptance_applied.v1";
const MAX_AUTOMATIC_CONTINUATIONS = 2;

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
  recordDecision(runtime.database, card, decision);
  if (decision.decision === "accept") return acceptIssue(runtime, card, decision);
  if (decision.decision === "needs_user") return requestUser(runtime, card, decision);
  if (automaticContinuationCount(runtime.database, card.issue.id) >= MAX_AUTOMATIC_CONTINUATIONS) {
    return requestUser(runtime, card, {
      ...decision,
      decision: "needs_user",
      rationale: `同一 Issue 已达到 ${MAX_AUTOMATIC_CONTINUATIONS} 次自动续跑上限。${decision.rationale}`,
      unmet_requirements: [
        ...decision.unmet_requirements,
        "自动续跑达到熔断上限，需要用户确认下一步"
      ]
    });
  }
  return continueSameSession(runtime, card, decision);
}

function acceptIssue(
  runtime: PiAcceptanceApplicationRuntime,
  card: CompletionCard,
  decision: PiAcceptanceDecision
): Issue {
  const db = runtime.database;
  const issue = mustGetIssue(db, card.issue.id);
  const work = projectIssueAsWork(db, issue);
  const runID = makeDomainID("run", "issue_runs", card.run.id);
  const now = new Date().toISOString();
  const evidence = piAcceptanceEvidence(card, decision, now);
  const handoff = listStoredHandoffs(db, {
    limit: 100,
    statuses: ["ready", "delivered"],
    work_id: work.id
  }).items.find((item) => item.handoff.run_ids.includes(runID));
  const handoffRequired = (work.acceptance.handoff_policy ?? "summary") === "required";
  if (handoffRequired && !handoff) {
    throw new Error("PI acceptance cannot complete a Work whose required Handoff is missing");
  }
  const acceptance: WorkAcceptanceEvidence = {
    contract_version: work.acceptance.version,
    evidence: [{
      criterion_ids: work.acceptance.criteria.filter((criterion) => criterion.required).map((criterion) => criterion.id),
      id: evidence.id,
      status: "passed",
      work_id: work.id
    }],
    handoffs: handoff ? [{
      id: handoff.handoff.id,
      status: handoff.handoff.status === "delivered" ? "delivered" : "ready",
      work_id: work.id
    }] : []
  };
  const audit = acceptanceAudit(card, now);
  const transition = evaluateWorkTransition({ relations: [], works: [work] }, {
    acceptance,
    audit,
    expected_revision: work.revision,
    to: "done",
    work_id: work.id
  });
  if (!transition.allowed) {
    throw new Error(`PI acceptance transition rejected: ${transition.violations.join("; ")}`);
  }
  const write = db.transaction(() => {
    recordEvidenceRecords(db, issue.id, [evidence], { recorded_at: now, source: "pi-issue-acceptance" });
    const completed = updateIssue(db, issue.id, { error: "", status: "done" });
    recordIssueEvent(db, issue.id, PI_ACCEPTANCE_APPLIED_EVENT, {
      action: "accept",
      card_fingerprint: card.fingerprint,
      decision,
      evidence_id: evidence.id,
      from_status: issue.status,
      run_id: card.run.id,
      status: "done"
    });
    recordIssueEvent(db, issue.id, "issue.status_changed", {
      actor: { id: "pi-issue-acceptance", kind: "supervisor" },
      reason: decision.rationale,
      status: "done"
    });
    return completed;
  }).immediate();
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
    updateIssue(db, issue.id, { error: "", status: "in_progress" });
    const created = createIssueRun(db, issue.id);
    recordIssueEvent(db, issue.id, PI_ACCEPTANCE_APPLIED_EVENT, {
      action: decision.decision,
      card_fingerprint: card.fingerprint,
      decision,
      new_run_id: created.id,
      resumed_from_run_id: previousRun.id,
      status: "in_progress"
    });
    recordIssueEvent(db, issue.id, "issue.status_changed", {
      actor: { id: "pi-issue-acceptance", kind: "supervisor" },
      reason: decision.rationale,
      status: "in_progress"
    });
    return created;
  }).immediate();
  publishStatus(runtime, mustGetIssue(db, issue.id));
  const selection = resolveExecutorSelection(db, project, issue);
  const serviceTier = issue.service_tier.trim() || project.default_service_tier.trim();
  try {
    await recoverIssueWithProvider(provider, {
      agentProfileId: selection.profile_id,
      agentRole: selection.agent_role,
      approvalPolicy: selection.approval_policy || project.approval_policy,
      bus: runtime.bus,
      capabilitySummary: provider.capabilities.join(","),
      cwd: project.cwd,
      database: db,
      issueId: issue.id,
      model: selection.model || project.model,
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
    return mustGetIssue(db, issue.id);
  } catch (error) {
    const message = safeError(error);
    const now = new Date().toISOString();
    db.sqlite.run(
      "update issue_runs set status='failed', ended_at=?, exit_reason='pi_acceptance_continuation_failed', error=? where id=?",
      [now, message, newRun.id]
    );
    updateIssue(db, issue.id, { error: message, status: "pending_verification" });
    recordIssueEvent(db, issue.id, "issue.pi_acceptance_continuation_failed.v1", {
      card_fingerprint: card.fingerprint,
      error: message,
      run_id: newRun.id
    });
    throw error;
  }
}

function requestUser(
  runtime: PiAcceptanceApplicationRuntime,
  card: CompletionCard,
  decision: PiAcceptanceDecision
): Issue {
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
    status: "pending_verification"
  });
  return mustGetIssue(runtime.database, card.issue.id);
}

function piAcceptanceEvidence(card: CompletionCard, decision: PiAcceptanceDecision, now: string): EvidenceRecord {
  const runID = makeDomainID("run", "issue_runs", card.run.id);
  return {
    schema_version: 1,
    id: makeDomainID("evidence", "issue_events", `pi-acceptance-${card.issue.id}-${card.fingerprint.slice(0, 32)}`),
    work_id: makeDomainID("work", "issues", card.issue.id),
    run_id: runID,
    attempt_id: makeRunAttemptID(runID, card.run.attempt),
    revision: 0,
    kind: "pi_acceptance",
    status: "passed",
    created_at: now,
    observed_at: now,
    updated_at: now,
    completed_at: now,
    decisive_output: {
      summary: decision.rationale,
      facts: {
        card_fingerprint: card.fingerprint,
        confidence: decision.confidence,
        decision: decision.decision,
        run_id: card.run.id
      }
    },
    artifact_refs: [{
      kind: "report",
      label: "PI completion card",
      ref: `issue-event:completion-card:${card.fingerprint}`
    }],
    provenance: {
      assertion_origin: "agent_claim",
      source_kind: "agent_statement",
      source_ref: `pi-acceptance:${card.fingerprint}`,
      audit_event_ref: `pi-acceptance:${card.issue.id}:${card.fingerprint}`,
      producer: { id: "pi-issue-acceptance", kind: "supervisor" }
    },
    redaction: { status: "not_required", policy_ref: "pi-acceptance-card-v1", redacted_paths: [] }
  };
}

function acceptanceAudit(card: CompletionCard, now: string): WorkTransitionAudit {
  return {
    actor: { id: "pi-issue-acceptance", kind: "supervisor" },
    correlation_id: `pi-acceptance:${card.issue.id}:${card.fingerprint}`,
    event_id: `pi-acceptance:${card.issue.id}:${card.fingerprint}`,
    gate: {
      authority: "deterministic_policy",
      decision: "allow",
      policy_ref: "pi-acceptance-application-v1"
    },
    occurred_at: now,
    reason: "Apply schema-valid issue-scoped PI acceptance to the exact completion-card fingerprint"
  };
}

function assertCurrentCard(db: RunnerDatabase, card: CompletionCard): void {
  const issue = mustGetIssue(db, card.issue.id);
  if (issue.status !== "pending_verification") {
    throw new Error(`PI acceptance requires pending_verification; Issue is ${issue.status}`);
  }
  const run = listIssueRuns(db, issue.id).at(-1);
  if (!run || run.id !== card.run.id || run.ended_at === "") {
    throw new Error("PI acceptance completion card is stale for the latest canonical Run");
  }
  if (issue.updated_at !== card.issue.updated_at) {
    throw new Error("PI acceptance completion card is stale for the current Issue revision");
  }
  if (readIssueVerificationProjection(db, issue.id).owner !== "pi") {
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

function automaticContinuationCount(db: RunnerDatabase, issueID: number): number {
  return listIssueEvents(db, issueID, { limit: 500, types: [PI_ACCEPTANCE_APPLIED_EVENT] })
    .filter((event) => {
      const action = cleanString(objectValue(parseJson(event.payload)).action);
      return action === "continue_same_session" || action === "code_review" || action === "independent_acceptance";
    }).length;
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
