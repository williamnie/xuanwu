import { randomUUID } from "node:crypto";
import type { RunnerDatabase } from "../../db/database.ts";
import { upsertAgentSession } from "../../db/repositories/agentSessions.ts";
import { recordIssueEvent, listIssueEvents } from "../../db/repositories/issueEvents.ts";
import { createIssueRun, updateIssueRuntime } from "../../db/repositories/issueRuns.ts";
import { getIssue, listIssueRuns, type Issue } from "../../db/repositories/issues.ts";
import { getProject, ProjectNotFoundError } from "../../db/repositories/projects.ts";
import { reviewIssueVerification } from "../../db/repositories/issueVerification.ts";
import { updateIssue } from "../../db/repositories/issueUpdate.ts";
import type { EventBus } from "../../events/bus.ts";
import {
  isExecutorProviderId,
  type ExecutorProvider,
  type ExecutorProviderId
} from "../../providers/types.ts";
import {
  readPiVerificationActivity,
  type PiVerificationActivity
} from "./piVerificationActivity.ts";

export const HUMAN_REVIEW_EVENT_TYPES = {
  requested: "issue.human_review_requested.v1",
  revisionResumeFailed: "issue.human_revision_resume_failed.v1",
  revisionResumed: "issue.human_revision_resumed.v1",
  revisionRequested: "issue.human_revision_requested.v1",
  superseded: "issue.human_review_superseded.v1"
} as const;

export type HumanReviewRequest = {
  acceptance_summary: string[];
  consequences: string;
  created_at: string;
  evidence_refs: string[];
  excluded_scope: string[];
  id: string;
  issue_id: number;
  kind: "decision" | "acceptance" | "risk_acceptance";
  question: string;
  recommendation: string;
  revision: number;
  status: "open" | "accepted" | "changes_requested" | "rejected" | "superseded";
};

export type IssueVerificationProjection = {
  owner: "human" | "pi";
  phase:
    | "human_review"
    | "pi_blocked"
    | "pi_queued"
    | "pi_repairing"
    | "pi_verifying"
    | "pi_waiting"
    | "complete";
  activity: PiVerificationActivity | null;
  request: HumanReviewRequest | null;
};

export type CreateHumanReviewRequestInput = {
  acceptance_summary?: unknown;
  consequences?: unknown;
  evidence_refs?: unknown;
  excluded_scope?: unknown;
  kind?: unknown;
  question?: unknown;
  recommendation?: unknown;
};

export type HumanReviewRuntime = {
  bus?: EventBus;
  providers?: Partial<Record<ExecutorProviderId, ExecutorProvider>>;
};

export class HumanReviewConflictError extends Error {}

export function createHumanReviewRequest(
  db: RunnerDatabase,
  issueID: number,
  input: CreateHumanReviewRequestInput,
  runtime: HumanReviewRuntime = {}
): HumanReviewRequest {
  const issue = mustGetIssue(db, issueID);
  if (issue.status !== "pending_verification") {
    throw new Error("只有 pending_verification Issue 才能请求人类验收");
  }
  const question = requiredText(input.question, "question");
  const current = readIssueVerificationProjection(db, issueID).request;
  const revision = (current?.revision ?? 0) + 1;
  if (current?.status === "open") {
    recordIssueEvent(db, issueID, HUMAN_REVIEW_EVENT_TYPES.superseded, {
      request_id: current.id,
      revision: current.revision,
      reason: "replaced_by_new_human_review_request"
    });
  }
  const request: HumanReviewRequest = {
    acceptance_summary: stringList(input.acceptance_summary),
    consequences: cleanString(input.consequences),
    created_at: new Date().toISOString(),
    evidence_refs: stringList(input.evidence_refs),
    excluded_scope: stringList(input.excluded_scope),
    id: `human-review-${issueID}-${randomUUID()}`,
    issue_id: issueID,
    kind: reviewKind(input.kind),
    question,
    recommendation: cleanString(input.recommendation),
    revision,
    status: "open"
  };
  recordIssueEvent(db, issueID, HUMAN_REVIEW_EVENT_TYPES.requested, request);
  const notificationText = humanReviewNotificationText(issue, request);
  runtime.bus?.publish({
    issueId: issueID,
    projectId: issue.project_id,
    type: "pi.needs_user",
    text: notificationText,
    payload: JSON.stringify({
      acceptance_summary: request.acceptance_summary,
      action_id: request.id,
      consequences: request.consequences,
      evidence_refs: request.evidence_refs,
      excluded_scope: request.excluded_scope,
      issue_id: issueID,
      message: question,
      next_step: "请打开 Work 验收，接受、要求调整或拒绝",
      recommendation: request.recommendation,
      reason: "human_review_required",
      requires_user: true,
      review_request_id: request.id,
      review_revision: request.revision,
      severity: "action",
      user_facing_message: notificationText
    })
  });
  return request;
}

export function readIssueVerificationProjection(
  db: RunnerDatabase,
  issueID: number
): IssueVerificationProjection {
  const issue = mustGetIssue(db, issueID);
  const events = listIssueEvents(db, issueID, {
    limit: 500,
    types: Object.values(HUMAN_REVIEW_EVENT_TYPES)
  });
  const requests = new Map<string, HumanReviewRequest>();
  for (const event of events) {
    const payload = objectPayload(event.payload);
    if (event.type === HUMAN_REVIEW_EVENT_TYPES.requested) {
      const request = requestFromPayload(payload, event.created_at);
      if (request) requests.set(request.id, request);
      continue;
    }
    const id = cleanString(payload.request_id);
    const current = requests.get(id);
    if (!current) continue;
    if (event.type === HUMAN_REVIEW_EVENT_TYPES.superseded) {
      const action = cleanString(payload.action);
      current.status = action === "accept"
        ? "accepted"
        : action === "reject"
          ? "rejected"
          : "superseded";
    }
    if (
      event.type === HUMAN_REVIEW_EVENT_TYPES.revisionRequested
      || event.type === HUMAN_REVIEW_EVENT_TYPES.revisionResumed
    ) current.status = "changes_requested";
    if (event.type === HUMAN_REVIEW_EVENT_TYPES.revisionResumeFailed) current.status = "open";
  }
  const request = [...requests.values()].sort((a, b) => b.revision - a.revision)[0] ?? null;
  const storedActivity = readPiVerificationActivity(db, issueID);
  const activity = activityAppliesToCurrentIssueState(storedActivity, issue.updated_at)
    ? storedActivity
    : null;
  if (issue.status === "done" || issue.status === "failed" || issue.status === "cancelled") {
    return { activity, owner: "pi", phase: "complete", request };
  }
  if (request?.status === "open") return { activity, owner: "human", phase: "human_review", request };
  return {
    activity,
    owner: "pi",
    phase: issue.status === "in_progress" && request?.status === "changes_requested"
      ? "pi_repairing"
      : piVerificationPhase(activity),
    request
  };
}

function activityAppliesToCurrentIssueState(
  activity: PiVerificationActivity | null,
  issueUpdatedAt: string
): boolean {
  if (!activity) return false;
  const activityAt = Date.parse(activity.updated_at);
  const issueAt = Date.parse(issueUpdatedAt);
  return !Number.isFinite(issueAt) || !Number.isFinite(activityAt) || activityAt >= issueAt;
}

function piVerificationPhase(
  activity: PiVerificationActivity | null
): IssueVerificationProjection["phase"] {
  if (!activity || activity.status === "queued") return "pi_queued";
  if (activity.status === "running") return "pi_verifying";
  if (activity.status === "failed") return "pi_blocked";
  return "pi_waiting";
}

export async function reviewHumanIssue(
  db: RunnerDatabase,
  issueID: number,
  input: Record<string, unknown>,
  runtime: HumanReviewRuntime = {}
): Promise<Issue> {
  const action = normalizeAction(input.action);
  const comment = cleanString(input.comment);
  const request = requireCurrentReviewRequest(db, issueID, input);
  if ((action === "request_changes" || action === "reject") && comment === "") {
    throw new Error(`${action} 必须填写具体意见`);
  }
  if (action === "request_changes") {
    return resumeRevisionInSameSession(db, mustGetIssue(db, issueID), request, comment, runtime);
  }
  if (action === "accept" && request.kind !== "acceptance") {
    if (comment) {
      recordIssueEvent(db, issueID, "issue.comment", {
        author: "user",
        body: comment,
        source: "human_review_accept"
      });
    }
    recordIssueEvent(db, issueID, "issue.verification_reviewed", {
      action,
      comment,
      request_id: request.id,
      revision: request.revision,
      status: "pending_verification"
    });
    recordIssueEvent(db, issueID, HUMAN_REVIEW_EVENT_TYPES.superseded, {
      action,
      comment,
      request_id: request.id,
      revision: request.revision
    });
    return mustGetIssue(db, issueID);
  }
  const issue = reviewIssueVerification(db, issueID, {
    action,
    comment
  });
  recordIssueEvent(db, issueID, HUMAN_REVIEW_EVENT_TYPES.superseded, {
    action,
    comment,
    request_id: request.id,
    revision: request.revision
  });
  return issue;
}

async function resumeRevisionInSameSession(
  db: RunnerDatabase,
  issue: Issue,
  request: HumanReviewRequest,
  feedback: string,
  runtime: HumanReviewRuntime
): Promise<Issue> {
  const previousRun = listIssueRuns(db, issue.id)
    .filter((run) => cleanString(run.provider_session_id) !== "")
    .at(-1);
  if (!previousRun) throw new Error("无法继续原 Session：未找到带 provider_session_id 的历史 Run");
  const providerID = cleanString(previousRun.provider);
  if (!isExecutorProviderId(providerID)) throw new Error(`无法继续原 Session：provider "${providerID}" 不受支持`);
  const provider = runtime.providers?.[providerID];
  if (!provider?.sendSessionMessage || !provider.capabilities.includes("resume_session")) {
    throw new Error(`provider "${providerID}" 不支持在原 Session 中继续调整`);
  }
  const project = getProject(db, issue.project_id);
  if (!project) throw new ProjectNotFoundError();

  const prepare = db.transaction(() => {
    recordIssueEvent(db, issue.id, "issue.comment", {
      author: "user",
      body: feedback,
      source: "human_review_request_changes"
    });
    updateIssue(db, issue.id, { error: "", status: "in_progress" });
    const run = createIssueRun(db, issue.id);
    recordIssueEvent(db, issue.id, HUMAN_REVIEW_EVENT_TYPES.revisionRequested, {
      feedback,
      new_run_id: run.id,
      provider: providerID,
      provider_session_id: previousRun.provider_session_id,
      request_id: request.id,
      revision: request.revision,
      resumed_from_run_id: previousRun.id,
      status: "executing"
    });
    return run;
  });
  const run = prepare.immediate();
  try {
    const result = await provider.sendSessionMessage({
      cwd: project.cwd,
      prompt: revisionPrompt(issue, request, feedback),
      projectId: project.id,
      sessionId: previousRun.provider_session_id
    });
    const sessionID = cleanString(result.provider_session_id)
      || cleanString(result.sessionId)
      || previousRun.provider_session_id;
    const turnID = requiredText(result.turn_id, "provider turn id");
    updateIssueRuntime(db, issue.id, {
      issue_run_id: run.id,
      provider: providerID,
      provider_session_id: sessionID,
      provider_turn_id: turnID,
      metadata: {
        human_review_request_id: request.id,
        human_review_revision: request.revision,
        resumed_from_run_id: previousRun.id,
        revision_source: "human_review"
      }
    });
    upsertAgentSession(db, {
      issue_id: issue.id,
      project_id: project.id,
      provider: providerID,
      provider_session_id: sessionID,
      raw_ref: { provider_turn_id: turnID },
      status: "running",
      title: issue.title
    });
    recordIssueEvent(db, issue.id, HUMAN_REVIEW_EVENT_TYPES.revisionResumed, {
      feedback,
      new_run_id: run.id,
      provider: providerID,
      provider_session_id: sessionID,
      provider_turn_id: turnID,
      request_id: request.id,
      revision: request.revision,
      resumed_from_run_id: previousRun.id
    });
    recordIssueEvent(db, issue.id, "issue.verification_reviewed", {
      action: "request_changes",
      comment: feedback,
      request_id: request.id,
      revision: request.revision,
      status: "in_progress"
    });
    recordIssueEvent(db, issue.id, "issue.status_changed", {
      reason: "human_requested_changes",
      status: "in_progress"
    });
    runtime.bus?.publish({
      issueId: issue.id,
      projectId: issue.project_id,
      status: "in_progress",
      type: "issue.status_changed"
    });
    return mustGetIssue(db, issue.id);
  } catch (error) {
    const now = new Date().toISOString();
    db.sqlite.run(
      "update issue_runs set status='failed', ended_at=?, exit_reason='human_revision_resume_failed', error=? where id=?",
      [now, safeError(error), run.id]
    );
    updateIssue(db, issue.id, { error: safeError(error), status: "pending_verification" });
    recordIssueEvent(db, issue.id, HUMAN_REVIEW_EVENT_TYPES.revisionResumeFailed, {
      error: safeError(error),
      request_id: request.id,
      revision: request.revision,
      run_id: run.id
    });
    throw error;
  }
}

function requireCurrentReviewRequest(
  db: RunnerDatabase,
  issueID: number,
  input: Record<string, unknown>
): HumanReviewRequest {
  const projection = readIssueVerificationProjection(db, issueID);
  const request = projection.request;
  if (projection.owner !== "human" || !request || request.status !== "open") {
    throw new HumanReviewConflictError("当前没有等待人类处理的验收请求；PI 仍负责自主验证或修复");
  }
  const requestID = requiredText(input.review_request_id, "review_request_id");
  const revision = positiveInteger(input.review_revision, "review_revision");
  if (requestID !== request.id || revision !== request.revision) {
    throw new HumanReviewConflictError("验收请求已更新，请刷新后重新审批");
  }
  return request;
}

function revisionPrompt(issue: Issue, request: HumanReviewRequest, feedback: string): string {
  return [
    `继续处理 Issue #${issue.id}：${issue.title}`,
    "",
    "这是已认证的人类验收调整意见。必须在当前 Session 中继续，但把本次工作记录为新的 Run/Turn；不要改写此前 Run 的历史。",
    `原审批问题：${request.question}`,
    `人类调整意见：${feedback}`,
    "",
    "请基于意见修改交付，执行最小充分验证，并更新证据。能由 PI/验证器确定的事项应自主验收；只有仍存在无法自主决定的产品、风险或范围取舍时，才创建一条新的、问题明确的人类验收请求。",
    "不得把调整意见解释为绕过权限、验证、范围或安全门禁。"
  ].join("\n");
}

function humanReviewNotificationText(issue: Issue, request: HumanReviewRequest): string {
  return [
    `玄武 Supervisor：issue #${issue.id} 需要你的明确审批。`,
    `你正在审批：${request.question}`,
    request.recommendation ? `PI 建议：${request.recommendation}` : "",
    request.acceptance_summary.length
      ? `接受范围：${request.acceptance_summary.join("；")}`
      : "",
    request.excluded_scope.length
      ? `不包含：${request.excluded_scope.join("；")}`
      : "",
    request.consequences ? `决定影响：${request.consequences}` : "",
    "可选操作：接受 / 要求调整 / 拒绝。要求调整时请直接填写意见，PI 会在同一个 Provider Session 的新 Run/Turn 中继续。"
  ].filter(Boolean).join("\n");
}

function requestFromPayload(payload: Record<string, unknown>, fallbackCreatedAt: string): HumanReviewRequest | null {
  const id = cleanString(payload.id);
  const issueID = positiveIntegerOrZero(payload.issue_id);
  const question = cleanString(payload.question);
  const revision = positiveIntegerOrZero(payload.revision);
  if (!id || !issueID || !question || !revision) return null;
  return {
    acceptance_summary: stringList(payload.acceptance_summary),
    consequences: cleanString(payload.consequences),
    created_at: cleanString(payload.created_at) || fallbackCreatedAt,
    evidence_refs: stringList(payload.evidence_refs),
    excluded_scope: stringList(payload.excluded_scope),
    id,
    issue_id: issueID,
    kind: reviewKind(payload.kind),
    question,
    recommendation: cleanString(payload.recommendation),
    revision,
    status: "open"
  };
}

function objectPayload(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function reviewKind(value: unknown): HumanReviewRequest["kind"] {
  const kind = cleanString(value);
  return kind === "decision" || kind === "risk_acceptance" ? kind : "acceptance";
}

function normalizeAction(value: unknown): "accept" | "reject" | "request_changes" {
  const action = cleanString(value).replaceAll("-", "_");
  if (action === "accept" || action === "reject" || action === "request_changes") return action;
  throw new Error("verification action 必须是 accept、reject 或 request_changes");
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.map(cleanString).filter(Boolean) : [];
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} 必须是正整数`);
  }
  return value;
}

function positiveIntegerOrZero(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function requiredText(value: unknown, label: string): string {
  const text = cleanString(value);
  if (text === "") throw new Error(`${label} 不能为空`);
  return text;
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function mustGetIssue(db: RunnerDatabase, issueID: number): Issue {
  const issue = getIssue(db, issueID);
  if (!issue) throw new ProjectNotFoundError();
  return issue;
}
