import type { RunnerDatabase } from "../../database.ts";
import {
  getPiApprovalRequest,
  updatePiApprovalRequest,
  type PiApprovalRequest
} from "./approvalRequests.ts";
import { cleanString } from "./common.ts";

type ResolverInput = {
  decision: string;
  error?: string;
  retryable?: boolean;
  scope?: string;
  status: string;
  timestamp?: Date;
};

export function markPiApprovalDelivered(
  db: RunnerDatabase,
  id: string,
  input: { channel: string; timestamp?: Date }
): PiApprovalRequest {
  const current = mustGetPiApprovalRequest(db, id);
  if (current.status !== "pending") return current;
  return updatePiApprovalRequest(db, id, {
    delivered_at: (input.timestamp ?? new Date()).toISOString(),
    delivery_channel: input.channel,
    delivery_state: "delivered",
    status: "delivered"
  });
}

export function recordPiApprovalResolverAttempt(
  db: RunnerDatabase,
  id: string,
  input: ResolverInput
): PiApprovalRequest {
  const current = mustGetPiApprovalRequest(db, id);
  if (isResolved(current.status)) return current;
  const error = cleanString(input.error);
  return updatePiApprovalRequest(db, id, {
    decision: cleanString(input.decision),
    resolver_attempt_count: current.resolver_attempt_count + 1,
    resolver_error: error,
    resolver_last_attempt_at: (input.timestamp ?? new Date()).toISOString(),
    resolver_retryable: input.retryable === true ? 1 : 0,
    resolver_status: cleanString(input.status),
    resolved_scope: cleanString(input.scope),
    status: error === "" ? current.status : "resolve_failed"
  });
}

export function resolvePiApprovalRequestRecord(
  db: RunnerDatabase,
  id: string,
  input: { decision: string; scope?: string; status?: string; timestamp?: Date }
): PiApprovalRequest {
  const current = mustGetPiApprovalRequest(db, id);
  if (isResolved(current.status)) return current;
  const decision = cleanString(input.decision);
  return updatePiApprovalRequest(db, id, {
    decision,
    resolver_error: "",
    resolver_retryable: 0,
    resolved_at: (input.timestamp ?? new Date()).toISOString(),
    resolved_decision: decision,
    resolved_scope: cleanString(input.scope),
    status: cleanString(input.status) || statusForDecision(decision)
  });
}

function isResolved(status: string): boolean {
  return ["approved", "rejected", "cancelled", "expired"].includes(status);
}

function statusForDecision(decision: string): string {
  return isApprovalDecision(decision) ? "approved" : "rejected";
}

function isApprovalDecision(decision: string): boolean {
  return ["approve", "approved", "accept", "approve_session", "approved_for_session", "acceptForSession"]
    .includes(decision);
}

function mustGetPiApprovalRequest(db: RunnerDatabase, id: string): PiApprovalRequest {
  const request = getPiApprovalRequest(db, id);
  if (!request) throw new Error("PI approval request missing after write");
  return request;
}
