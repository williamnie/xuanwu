import type { RunnerDatabase } from "../../db/database.ts";
import { listIssueEvents } from "../../db/repositories/issueEvents.ts";
import { getIssue, type Issue } from "../../db/repositories/issues.ts";
import { ProjectNotFoundError } from "../../db/repositories/projects.ts";
import type { EventBus } from "../../events/bus.ts";
import { type ExecutorProvider, type ExecutorProviderId } from "../../providers/types.ts";
import { type PiAcceptanceActivity } from "./piAcceptanceActivity.ts";
import { cleanString, objectValue, stringList } from "../../util/values.ts";

export const HUMAN_REVIEW_EVENT_TYPES = {
  requested: "issue.human_review_requested.v1",
  redundantClosed: "issue.human_review_redundant_closed.v1",
  restored: "issue.human_review_restored.v1",
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
  origin_card_fingerprint: string;
  origin_run_id: string;
  question: string;
  recommendation: string;
  revision: number;
  status: "open" | "accepted" | "changes_requested" | "rejected" | "superseded";
};

export type IssueDecisionProjection = {
  owner: "human" | "pi";
  phase:
    | "human_review"
    | "pi_error"
    | "pi_queued"
    | "pi_continuing"
    | "pi_deciding"
    | "pi_waiting"
    | "complete";
  activity: PiAcceptanceActivity | null;
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

export type ReopenIncorrectAcceptanceInput = CreateHumanReviewRequestInput & {
  recovery_reason?: unknown;
  reopen_accepted_request_id?: unknown;
  reopen_accepted_revision?: unknown;
};

export type HumanReviewRuntime = {
  bus?: Pick<EventBus, "publish">;
  providers?: Partial<Record<ExecutorProviderId, ExecutorProvider>>;
};

export class HumanReviewConflictError extends Error {}

export function revisionPrompt(issue: Issue, request: HumanReviewRequest, feedback: string): string {
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

export function humanReviewNotificationText(issue: Issue, request: HumanReviewRequest): string {
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

export function requestFromPayload(payload: Record<string, unknown>, fallbackCreatedAt: string): HumanReviewRequest | null {
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
    origin_card_fingerprint: cleanString(payload.origin_card_fingerprint)
      || completionCardFingerprint(stringList(payload.evidence_refs)),
    origin_run_id: cleanString(payload.origin_run_id),
    question,
    recommendation: cleanString(payload.recommendation),
    revision,
    status: "open"
  };
}

export function reviewOrigin(
  db: RunnerDatabase,
  issueID: number,
  evidenceRefs: string[]
): { cardFingerprint: string; runID: string } {
  const cardFingerprint = completionCardFingerprint(evidenceRefs);
  if (cardFingerprint === "") return { cardFingerprint: "", runID: "" };
  const event = listIssueEvents(db, issueID, {
    limit: 100,
    types: ["issue.completion_card.v1"]
  }).find((candidate) => cleanString(objectPayload(candidate.payload).fingerprint) === cardFingerprint);
  const card = objectValue(objectPayload(event?.payload ?? "").card);
  return {
    cardFingerprint,
    runID: cleanString(objectValue(card.run).id)
  };
}

function completionCardFingerprint(evidenceRefs: string[]): string {
  return evidenceRefs
    .map((reference) => reference.match(/^completion-card:([a-f0-9]{64})$/)?.[1] ?? "")
    .find(Boolean) ?? "";
}

export function objectPayload(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

export function reviewKind(value: unknown): HumanReviewRequest["kind"] {
  const kind = cleanString(value);
  return kind === "decision" || kind === "risk_acceptance" ? kind : "acceptance";
}

export function normalizeAction(value: unknown): "accept" | "reject" | "request_changes" {
  const action = cleanString(value).replaceAll("-", "_");
  if (action === "accept" || action === "reject" || action === "request_changes") return action;
  throw new Error("human review action 必须是 accept、reject 或 request_changes");
}

export function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} 必须是正整数`);
  }
  return value;
}

function positiveIntegerOrZero(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : 0;
}

export function requiredText(value: unknown, label: string): string {
  const text = cleanString(value);
  if (text === "") throw new Error(`${label} 不能为空`);
  return text;
}

export function mustGetIssue(db: RunnerDatabase, issueID: number): Issue {
  const issue = getIssue(db, issueID);
  if (!issue) throw new ProjectNotFoundError();
  return issue;
}
