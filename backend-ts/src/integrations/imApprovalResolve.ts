import type { RunnerDatabase } from "../db/database.ts";
import { getPiApprovalRequest } from "../db/repositories/pi/approvalRequests.ts";
import {
  recordPiApprovalResolverAttempt,
  resolvePiApprovalRequestRecord
} from "../db/repositories/pi/approvalLifecycle.ts";
import type { ApprovalDecision, ExecutorProvider, ExecutorProviderId } from "../providers/types.ts";
import { constrainApprovalGrantScope } from "../pi/approvalGrantScope.ts";
import { redactSensitiveText } from "../util/redact.ts";

export type ImApprovalResolveInput = {
  decision: string;
  provider?: Pick<ExecutorProvider, "resolveApproval">;
  providers?: Partial<Record<ExecutorProviderId, Pick<ExecutorProvider, "resolveApproval">>>;
  requestID: string;
  scope: string;
};

/** Provider-neutral business transition after an IM adapter has verified its callback token. */
export async function resolvePiApprovalRequestFromIm(
  db: RunnerDatabase,
  input: ImApprovalResolveInput
): Promise<{ ok: true; status: string }> {
  const request = getPiApprovalRequest(db, input.requestID);
  if (!request) throw new Error("pi approval request not found");
  if (["approved", "rejected", "cancelled", "expired"].includes(request.status)) return { ok: true, status: request.status };
  const decision = normalizeApprovalDecision(input.decision || request.decision || request.resolved_decision);
  const scope = cleanScope(input.scope || request.resolved_scope);
  const scoped = constrainApprovalGrantScope({ decision, scope }, {
    provider: request.provider,
    requestType: request.request_type,
    sessionId: request.session_id || request.thread_id
  });
  if (decision !== "defer") {
    const provider = input.provider ?? providerForRequest(input.providers, request.provider);
    await resolveProviderApproval(db, request.approval_id, request.provider_approval_id || request.approval_id, provider, {
      decision: scoped.decision.decision,
      scope: scoped.decision.scope
    });
    recordPiApprovalResolverAttempt(db, request.approval_id, {
      decision: scoped.decision.decision,
      scope: scoped.decision.scope,
      status: "succeeded"
    });
  }
  const resolved = resolvePiApprovalRequestRecord(db, request.approval_id, {
    decision: decision === "defer" ? decision : scoped.decision.decision,
    scope: decision === "defer" ? scope : scoped.decision.scope,
    status: decision === "defer" ? "delivered" : undefined
  });
  return { ok: true, status: resolved.status };
}

function providerForRequest(
  providers: ImApprovalResolveInput["providers"],
  providerID: string
): Pick<ExecutorProvider, "resolveApproval"> | undefined {
  const id = providerID.trim();
  return id === "" ? providers?.codex : providers?.[id as ExecutorProviderId];
}

async function resolveProviderApproval(
  db: RunnerDatabase,
  requestID: string,
  providerApprovalID: string,
  provider: Pick<ExecutorProvider, "resolveApproval"> | undefined,
  decision: ApprovalDecision
): Promise<void> {
  try {
    if (!provider?.resolveApproval) throw new Error("codex provider approval resolver is not available");
    await provider.resolveApproval(providerApprovalID, decision);
  } catch (error) {
    recordPiApprovalResolverAttempt(db, requestID, {
      decision: decision.decision,
      error: safeError(error),
      retryable: true,
      scope: decision.scope,
      status: "failed"
    });
    throw error;
  }
}

function normalizeApprovalDecision(value: string): string {
  const text = value.trim();
  if (["approve_session", "approved_for_session", "acceptForSession"].includes(text)) return "approve_session";
  if (["approve", "approved", "accept", "approve_once"].includes(text)) return "approve";
  if (["defer", "snooze", "later"].includes(text)) return "defer";
  return "deny";
}

function cleanScope(value: string): string {
  return value.trim() === "session" ? "session" : "turn";
}

function safeError(error: unknown): string {
  return redactSensitiveText(error instanceof Error ? error.message : "approval resolver failed").trim();
}
