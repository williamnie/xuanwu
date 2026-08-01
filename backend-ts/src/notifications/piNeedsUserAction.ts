import type { RunnerDatabase } from "../db/database.ts";
import { getAgentSession } from "../db/repositories/agentSessions.ts";
import { createIssueComment } from "../db/repositories/issueEvents.ts";
import { getIssue, listIssueRuns, type Issue, type IssueRun } from "../db/repositories/issues.ts";
import type { PiAction } from "../db/repositories/pi.ts";
import { upsertPiGuardianAlert } from "../db/repositories/pi.ts";
import { getProject } from "../db/repositories/projects.ts";
import type { EventBus } from "../events/bus.ts";
import { redactedUserVisibleText } from "../util/redact.ts";
import { composePiNeedsUserMessage } from "./piNeedsUserMessageComposer.ts";
import { publishPiNeedsUserNotification } from "./piNotifier.ts";
import { SUPERVISOR_NOTIFICATION_PREFIX } from "../xuanwu/userFacingTerminology.ts";
import { applyPiSemanticIssueStatus } from "../runner/piIssueLifecycle.ts";

export type PiNeedsUserActionContext = {
  bus?: Pick<EventBus, "publish">;
  database: RunnerDatabase;
};

export function dispatchNeedsUserEscalation(
  context: PiNeedsUserActionContext,
  action: PiAction,
  payload: Record<string, unknown>
): unknown {
  const issueID = positivePayloadID(payload, "issue_id");
  const preflight = needsUserPreflight(context.database, action, payload, issueID);
  if (preflight.skip) {
    return { comment: null, notification: null, released: null, skipped: true, reason: preflight.reason };
  }
  const issue = preflight.issue;
  const project = getProject(context.database, issue.project_id);
  const provider = cleanString(payload.provider) || cleanString(preflight.run?.provider);
  const diagnosis = cleanString(payload.diagnosis_code) || cleanString(payload.reason) || action.rationale;
  const rawMessage = cleanString(payload.body) || cleanString(payload.message);
  const nextStep = cleanString(payload.next_step) || cleanString(payload.nextStep);
  const userFacingMessage = composePiNeedsUserMessage({
    diagnosis,
    issue,
    message: rawMessage,
    nextStep,
    provider,
    run: preflight.run,
    session: preflight.session
  });
  upsertPiGuardianAlert(context.database, {
    alert_type: "supervisor_needs_user",
    evidence_json: [
      `issue:${issue.id}`,
      cleanString(payload.decision_id) || `action:${action.id}`
    ],
    issue_id: issue.id,
    message: userFacingMessage || rawMessage || diagnosis,
    project_id: issue.project_id,
    run_group_id: `needs-user:${issue.id}:${action.id}`,
    severity: "high",
    watchdog_seen_at: new Date().toISOString()
  });
  const published = publishPiNeedsUserNotification({
    actionID: action.id,
    bus: context.bus,
    database: context.database,
    diagnosis,
    issue,
    message: rawMessage,
    nextStep,
    project: { id: issue.project_id, name: project?.name ?? issue.project_id },
    provider,
    userFacingMessage
  });
  const body = published?.message ?? (userFacingMessage || needsUserCommentBody(action, issue, payload));
  const released = holdForUserDecision(context.database, issue, payload);
  if (hasNeedsUserComment(context.database, issueID, action.id)) {
    return { comment: null, notification: published, released, skipped_comment: "duplicate" };
  }
  const comment = createIssueComment(context.database, issueID, {
    author: "agent",
    body: `${body}\nAction：${redactActionID(action.id)}`
  });
  return { comment, notification: published, released };
}

type NeedsUserPreflight =
  | { issue: Issue; run: IssueRun | undefined; session: ReturnType<typeof getAgentSession>; skip: false }
  | { reason: string; skip: true };

const RECENT_SESSION_ACTIVITY_GRACE_MS = 5 * 60 * 1000;

function needsUserPreflight(
  db: RunnerDatabase,
  action: PiAction,
  payload: Record<string, unknown>,
  issueID: number
): NeedsUserPreflight {
  const issue = getIssue(db, issueID);
  if (!issue) throw new Error("issue not found");
  const run = latestIssueRun(db, issueID);
  const session = expectedSession(db, payload, run);
  if (!guardianAction(action, payload)) return { issue, run, session, skip: false };
  const changed = changedPrecondition(issue, run, session, payload);
  if (changed !== "" && !canRevalidateTerminalEscalation(issue, run)) {
    return { reason: changed, skip: true };
  }
  if (run?.ended_at === "" && recentSessionActivity(session?.updated_at, payload, new Date())) {
    return { reason: "recent_session_activity", skip: true };
  }
  return { issue, run, session, skip: false };
}

function canRevalidateTerminalEscalation(issue: Issue, run: IssueRun | undefined): boolean {
  if (issue.status === "done" || issue.status === "cancelled" || issue.status === "todo") return false;
  return !run || run.ended_at !== "";
}

function guardianAction(action: PiAction, payload: Record<string, unknown>): boolean {
  return action.source === "pi_guardian_orchestrator" || cleanString(payload.guardian_decision_id) !== "" ||
    cleanString(payload.decision_id).startsWith("guardian:");
}

function latestIssueRun(db: RunnerDatabase, issueID: number): IssueRun | undefined {
  return listIssueRuns(db, issueID).at(-1);
}

function expectedSession(db: RunnerDatabase, payload: Record<string, unknown>, run: IssueRun | undefined) {
  const provider = cleanString(payload.provider) || cleanString(run?.provider) || "codex";
  const sessionID = cleanString(payload.expected_provider_session_id) || cleanString(payload.provider_session_id) ||
    cleanString(run?.provider_session_id);
  return sessionID === "" ? null : getAgentSession(db, `${provider}:${sessionID}`);
}

function changedPrecondition(
  issue: Issue,
  run: IssueRun | undefined,
  session: ReturnType<typeof getAgentSession>,
  payload: Record<string, unknown>
): string {
  if (expectedChanged(payload.expected_issue_updated_at, issue.updated_at) ||
    expectedChanged(payload.expected_issue_status, issue.status)) return "issue_changed";
  if (expectedChanged(payload.expected_run_id, run?.id ?? "") ||
    expectedChanged(payload.expected_provider_session_id, run?.provider_session_id ?? "") ||
    expectedChanged(payload.expected_provider_turn_id, run?.provider_turn_id ?? "") ||
    expectedChanged(payload.expected_run_status, run?.status ?? "") ||
    expectedChanged(payload.expected_run_ended_at, run?.ended_at ?? "")) return "run_changed";
  if (expectedChanged(payload.expected_session_updated_at, session?.updated_at ?? "") ||
    expectedChanged(payload.expected_session_status, session?.status ?? "") ||
    expectedChanged(payload.expected_session_turn_id, rawRefTurnID(session?.raw_ref))) return "session_changed";
  return "";
}

function expectedChanged(expected: unknown, actual: string): boolean {
  const text = cleanString(expected);
  return text !== "" && text !== actual;
}

function recentSessionActivity(updatedAt: string | undefined, payload: Record<string, unknown>, now: Date): boolean {
  const expected = cleanString(payload.expected_session_updated_at);
  if (expected === "") return false;
  const updated = Date.parse(cleanString(updatedAt));
  if (!Number.isFinite(updated)) return false;
  if (!expectedChanged(expected, cleanString(updatedAt))) {
    return now.getTime() - updated <= RECENT_SESSION_ACTIVITY_GRACE_MS;
  }
  const observed = Date.parse(expected);
  return Number.isFinite(updated) && Number.isFinite(observed) &&
    updated > observed && updated - observed <= RECENT_SESSION_ACTIVITY_GRACE_MS;
}

function rawRefTurnID(rawRef: string | undefined): string {
  if (!rawRef) return "";
  try {
    return cleanString((JSON.parse(rawRef) as Record<string, unknown>).provider_turn_id);
  } catch {
    return "";
  }
}

function needsUserCommentBody(action: PiAction, issue: Issue, payload: Record<string, unknown>): string {
  const provider = redactCommentText(payload.provider);
  const diagnosis = redactCommentText(payload.diagnosis_code) || redactCommentText(payload.reason) ||
    redactCommentText(action.rationale) || "needs_user";
  const message = redactCommentText(payload.body) || redactCommentText(payload.message) || "Supervisor 判断当前无法继续自动恢复。";
  const nextStep = redactCommentText(payload.next_step) || redactCommentText(payload.nextStep) ||
    "请查看 Runner issue 并补充授权、凭证或下一步处理方式。";
  return [
    `${SUPERVISOR_NOTIFICATION_PREFIX}：issue #${issue.id} 需要用户介入。`,
    provider ? `Provider：${provider}` : "",
    `诊断：${diagnosis}`,
    `摘要：${message}`,
    `下一步：${nextStep}`
  ].filter(Boolean).join("\n");
}

function holdForUserDecision(db: RunnerDatabase, issue: Issue, payload: Record<string, unknown>): Issue | null {
  if (issue.status !== "in_progress") return null;
  return applyPiSemanticIssueStatus(db, issue.id, {
    card_fingerprint: cleanString(payload.decision_id) || `supervisor-needs-user:${issue.id}:${issue.updated_at}`,
    decision: "needs_user",
    reason: needsUserIssueError(payload),
    run_id: cleanString(payload.expected_run_id),
    status: "needs_user"
  });
}

function needsUserIssueError(payload: Record<string, unknown>): string {
  const diagnosis = redactCommentText(payload.diagnosis_code) || redactCommentText(payload.reason) || "needs_user";
  const message = redactCommentText(payload.message) || redactCommentText(payload.body) || "Supervisor 判断当前无法继续自动恢复。";
  const nextStep = redactCommentText(payload.next_step) || redactCommentText(payload.nextStep);
  return [
    `needs_user: ${diagnosis}`,
    message,
    nextStep ? `下一步：${nextStep}` : ""
  ].filter(Boolean).join("\n");
}

function hasNeedsUserComment(db: RunnerDatabase, issueID: number, actionID: string): boolean {
  const marker = `Action：${redactActionID(actionID)}`;
  return db.sqlite.query<{ found: number }, [number, string]>(
    `select 1 as found
     from issue_events
     where issue_id=? and type='issue.comment' and instr(payload, ?) > 0
     limit 1`
  ).get(issueID, marker)?.found === 1;
}

function positivePayloadID(payload: Record<string, unknown>, key: string): number {
  const id = payload[key];
  if (typeof id === "number" && Number.isSafeInteger(id) && id > 0) return id;
  throw new Error(`${key} is required`);
}

function redactActionID(value: unknown): string {
  return redactCommentText(value) || "needs_user.escalate";
}

function redactCommentText(value: unknown): string {
  return redactedUserVisibleText(cleanString(value));
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
