import type { RunnerDatabase } from "../database.ts";
import {
  applyIssueCompletionGate,
  createManualOverrideEvidence,
  ISSUE_VERIFICATION_GATE_EVENT_TYPES
} from "../../domain/evidence/completionGate.ts";
import { cleanString, issueTimestamp } from "./issueCreate.ts";
import { getIssue, type Issue } from "./issues.ts";
import { ProjectNotFoundError } from "./projects.ts";

const STATUS_DONE = "done";
const STATUS_FAILED = "failed";
const STATUS_PENDING_VERIFICATION = "pending_verification";
const STATUS_TRIAGE = "triage";

type IssueVerificationInput = {
  action?: unknown;
  comment?: unknown;
};

type VerificationPatch = {
  error: string;
  status: string;
};

export function reviewIssueVerification(
  db: RunnerDatabase,
  id: number,
  input: IssueVerificationInput
): Issue {
  const issue = mustGetIssue(db, id);
  if (issue.status !== STATUS_PENDING_VERIFICATION) {
    throw new Error("issue 当前不在 pending_verification 状态");
  }
  const action = normalizeVerificationAction(input.action);
  const comment = cleanString(input.comment);
  const patch = verificationPatch(action, comment);
  const timestamp = issueTimestamp();
  const write = db.transaction((): Issue => {
    const eventBase = { issueID: issue.id, timestamp };
    if (comment !== "") recordIssueComment(db, { ...eventBase, comment });
    if (action === "accept") {
      const auditEventRef = `issue-verification-review:${issue.id}:${timestamp}`;
      const manual = createManualOverrideEvidence(issue, {
        audit_event_ref: auditEventRef,
        comment,
        now: timestamp
      });
      recordIssueEvent(db, {
        ...eventBase,
        type: ISSUE_VERIFICATION_GATE_EVENT_TYPES.humanEvidence,
        payload: { action, audit_event_ref: auditEventRef, evidence: manual.evidence }
      });
      recordVerificationReviewed(db, { ...eventBase, action, comment, status: patch.status });
      return applyIssueCompletionGate(db, issue.id, {
        actor: { id: "issue-verification-api", kind: "user" },
        correlation_id: auditEventRef,
        evidence: [manual.evidence],
        manual_override: manual.override,
        now: timestamp,
        patch,
        source: "issue-verification-api"
      }).issue;
    }
    updateIssueReview(db, { issueID: issue.id, patch, timestamp });
    recordVerificationReviewed(db, { ...eventBase, action, comment, status: patch.status });
    recordStatusChanged(db, { ...eventBase, status: patch.status });
    return mustGetIssue(db, issue.id);
  });
  return write.immediate();
}

function normalizeVerificationAction(value: unknown): string {
  const action = cleanString(value).replaceAll("-", "_");
  if (action === "accept" || action === "reject" || action === "request_changes") return action;
  throw new Error("verification action 必须是 accept、reject 或 request_changes");
}

function verificationPatch(action: string, comment: string): VerificationPatch {
  switch (action) {
    case "accept":
      return { status: STATUS_DONE, error: "" };
    case "reject":
      return { status: STATUS_FAILED, error: comment || "Verification rejected" };
    default:
      return { status: STATUS_TRIAGE, error: comment || "Verification requested changes" };
  }
}

type IssueReviewUpdate = {
  issueID: number;
  patch: VerificationPatch;
  timestamp: string;
};

type IssueEventInput = {
  issueID: number;
  payload: Record<string, unknown>;
  timestamp: string;
  type: string;
};

function updateIssueReview(db: RunnerDatabase, input: IssueReviewUpdate): void {
  db.sqlite.run(
    `update issues set status=?, error=?, auto_retry_next_at='', auto_retry_reason='', updated_at=? where id=?`,
    [input.patch.status, input.patch.error, input.timestamp, input.issueID]
  );
}

function recordIssueComment(
  db: RunnerDatabase,
  input: { comment: string; issueID: number; timestamp: string }
): void {
  recordIssueEvent(db, {
    issueID: input.issueID,
    type: "issue.comment",
    payload: { author: "user", body: input.comment },
    timestamp: input.timestamp
  });
}

function recordVerificationReviewed(
  db: RunnerDatabase,
  input: { action: string; comment: string; issueID: number; status: string; timestamp: string }
): void {
  recordIssueEvent(db, {
    issueID: input.issueID,
    type: "issue.verification_reviewed",
    payload: { action: input.action, comment: input.comment, status: input.status },
    timestamp: input.timestamp
  });
}

function recordStatusChanged(
  db: RunnerDatabase,
  input: { issueID: number; status: string; timestamp: string }
): void {
  recordIssueEvent(db, {
    issueID: input.issueID,
    type: "issue.status_changed",
    payload: { status: input.status },
    timestamp: input.timestamp
  });
}

function recordIssueEvent(db: RunnerDatabase, input: IssueEventInput): void {
  db.sqlite.run(
    `insert into issue_events (issue_id, type, payload, created_at) values (?, ?, ?, ?)`,
    [input.issueID, input.type, JSON.stringify(input.payload), input.timestamp]
  );
}

function mustGetIssue(db: RunnerDatabase, id: number): Issue {
  const issue = getIssue(db, id);
  if (!issue) throw new ProjectNotFoundError();
  return issue;
}
