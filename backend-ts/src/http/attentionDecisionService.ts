import type { RunnerDatabase } from "../db/database.ts";
import {
  getActionProposal,
  getPiAction,
  getPiApprovalRequest,
  listPiActionEvents,
  rejectActionProposal
} from "../db/repositories/pi.ts";
import { updateAttentionInboxItemStatus } from "../db/repositories/intakeRuns.ts";
import type { EventBus } from "../events/bus.ts";
import { resolvePiApprovalRequestFromFeishu } from "../integrations/feishuApprovalRequests.ts";
import type { ExecutorProvider, ExecutorProviderId } from "../providers/types.ts";
import { recordPiActionAuditEvent } from "../pi/actionEngine.ts";
import { executeApprovedPiAction, resolvePiActionDecision } from "./piActionDecision.ts";
import { approveAndExecuteActionProposal } from "./piActionProposalExecution.ts";
import type { ProjectLoopStarter } from "./piActionDispatch.ts";
import { HttpError } from "./errors.ts";

export type AttentionDecisionContext = {
  bus?: EventBus;
  database: RunnerDatabase;
  providers?: Partial<Record<ExecutorProviderId, ExecutorProvider>>;
  startProjectLoop?: ProjectLoopStarter;
};

type DecisionBody = Record<string, unknown>;

export const LEGACY_ATTENTION_MUTATION_HEADERS = {
  deprecation: "true",
  link: '</api/command-center/summary?sections=attention>; rel="successor-version"',
  warning: '299 - "Use the Command Center Attention decision endpoint"'
} as const;

export async function resolveAttentionDecision(
  context: AttentionDecisionContext,
  input: { action: string; body: DecisionBody; relatedRefs: string[]; sourceRefs: Array<{ authority: string; local_id: string }> }
): Promise<{ decision_ref: string; result: unknown }> {
  const candidates = decisionRefs(input.sourceRefs, input.relatedRefs);
  const ref = selectedDecisionRef(input.body, candidates);
  if (ref.startsWith("proposal:")) {
    return { decision_ref: ref, result: await resolveProposalDecision(context, ref.slice("proposal:".length), input.action, input.body) };
  }
  if (ref.startsWith("pi_action:")) {
    return { decision_ref: ref, result: await resolveInternalActionDecision(context, ref.slice("pi_action:".length), input.action, input.body) };
  }
  if (ref.startsWith("approval:")) {
    return { decision_ref: ref, result: await resolveProviderApprovalDecision(context, ref.slice("approval:".length), input.action, input.body) };
  }
  throw new HttpError(409, "Attention has no proposal or approval decision target");
}

export async function resolveProposalDecision(
  context: AttentionDecisionContext,
  proposalID: string,
  action: string,
  body: DecisionBody
): Promise<unknown> {
  const proposal = getActionProposal(context.database, proposalID);
  if (!proposal) throw new HttpError(404, "action proposal not found");
  const actor = actorID(body);
  if (action === "approve") {
    const result = await approveAndExecuteActionProposal(context, {
      actionEdits: actionEdits(body.action_edits ?? body.actionEdits),
      actor,
      proposalID
    });
    recordProposalAudit(context.database, result, "action_proposal.approved", actor, cleanString(body.reason));
    for (const [index, execution] of result.executions.entries()) {
      const child = getPiAction(context.database, execution.pi_action_id);
      if (child) recordProposalAuditOnAction(
        context.database,
        child.id,
        result.id,
        "action_proposal.action_mapped",
        actor,
        "",
        { proposal_action_id: result.actions[index]?.id ?? "" }
      );
    }
    return result;
  }
  if (action !== "reject") throw new HttpError(400, "unsupported proposal decision");
  const rejected = rejectActionProposal(context.database, proposalID, actor, cleanString(body.reason));
  for (const source of rejected.source_item_ids) {
    const id = inboxItemID(source);
    if (id > 0) updateAttentionInboxItemStatus(context.database, id, "ignored");
  }
  recordProposalAudit(context.database, rejected, "action_proposal.rejected", actor, cleanString(body.reason));
  return rejected;
}

export async function resolveInternalActionDecision(
  context: AttentionDecisionContext,
  actionID: string,
  action: string,
  body: DecisionBody = {}
): Promise<unknown> {
  if (action === "execute") return await executeApprovedPiAction(context, actionID);
  if (!["approve", "reject", "request_changes", "snooze"].includes(action)) {
    throw new HttpError(400, "unsupported PI action decision");
  }
  return await resolvePiActionDecision(context, {
    actionID,
    actor: actorID(body),
    comment: cleanString(body.comment ?? body.reason ?? body.requested_changes),
    decision: action as "approve" | "reject" | "request_changes" | "snooze",
    reason: cleanString(body.reason),
    snoozedUntil: cleanString(body.until ?? body.snoozed_until)
  });
}

export async function resolveProviderApprovalDecision(
  context: AttentionDecisionContext,
  approvalID: string,
  action: string,
  body: DecisionBody = {}
): Promise<unknown> {
  const approval = getPiApprovalRequest(context.database, approvalID);
  if (!approval) throw new HttpError(404, "PI approval request 不存在");
  const decision = providerDecision(action, body);
  try {
    const result = await resolvePiApprovalRequestFromFeishu(context.database, {
      decision,
      providers: context.providers,
      requestID: approvalID,
      scope: cleanString(body.scope) || "turn"
    });
    const resolved = getPiApprovalRequest(context.database, approvalID);
    context.bus?.publish({
      projectId: resolved?.project_id,
      status: result.status,
      type: "approval.resolved",
      payload: JSON.stringify({ approval_id: approvalID, decision: resolved?.resolved_decision, scope: resolved?.resolved_scope })
    });
    return result;
  } catch (error) {
    throw new HttpError(409, error instanceof Error ? error.message : "PI approval request failed");
  }
}

function decisionRefs(
  sources: Array<{ authority: string; local_id: string }>,
  related: string[]
): string[] {
  return [...new Set([
    ...sources.flatMap((ref) => {
      if (ref.authority === "pi_actions") return [`pi_action:${ref.local_id}`];
      if (ref.authority === "pi_approval_requests") return [`approval:${ref.local_id}`];
      return [];
    }),
    ...related.filter((ref) => ref.startsWith("proposal:"))
  ])];
}

function selectedDecisionRef(body: DecisionBody, candidates: string[]): string {
  const requested = cleanString(body.decision_ref ?? body.decisionRef);
  if (requested !== "") {
    if (!candidates.includes(requested)) throw new HttpError(409, "decision_ref is not linked to this Attention");
    return requested;
  }
  if (candidates.length !== 1) throw new HttpError(409, "decision_ref is required when Attention has multiple decision targets");
  return candidates[0];
}

function providerDecision(action: string, body: DecisionBody): string {
  const explicit = cleanString(body.decision);
  if (explicit !== "") return explicit;
  if (action === "approve") return "approve";
  if (action === "reject") return "deny";
  if (action === "snooze") return "defer";
  throw new HttpError(400, "unsupported approval decision");
}

function recordProposalAudit(
  db: RunnerDatabase,
  proposal: NonNullable<ReturnType<typeof getActionProposal>>,
  eventType: string,
  actor: string,
  reason: string
): void {
  const parent = getPiAction(db, proposal.skill_run_id);
  if (!parent) return;
  recordProposalAuditOnAction(db, parent.id, proposal.id, eventType, actor, reason, {
    action_count: proposal.actions.length,
    source_item_ids: proposal.source_item_ids,
    status: proposal.status
  });
}

function recordProposalAuditOnAction(
  db: RunnerDatabase,
  actionID: string,
  proposalID: string,
  eventType: string,
  actor: string,
  reason = "",
  extra: Record<string, unknown> = {}
): void {
  const action = getPiAction(db, actionID);
  if (!action || hasProposalEvent(db, actionID, proposalID, eventType)) return;
  recordPiActionAuditEvent(db, action, eventType, {
    actor,
    decision: eventType.split(".").at(-1),
    payload: { ...extra, proposal_id: proposalID, proposal_ref: `proposal:${proposalID}` },
    reason
  });
}

function hasProposalEvent(db: RunnerDatabase, actionID: string, proposalID: string, eventType: string): boolean {
  return listPiActionEvents(db, { actionId: actionID, eventType }).some((event) => {
    try { return (JSON.parse(event.payload_json) as { proposal_id?: string }).proposal_id === proposalID; } catch { return false; }
  });
}

function actorID(body: DecisionBody): string {
  const direct = cleanString(body.actor);
  if (direct) return direct;
  const audit = objectValue(body.audit);
  const actor = objectValue(audit.actor);
  return cleanString(actor.id) || "user";
}

function actionEdits(value: unknown): Record<string, { payload?: DecisionBody }> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, { payload?: DecisionBody }>
    : {};
}

function inboxItemID(value: string): number {
  const match = /^(?:attention_inbox_item:)?(\d+)$/.exec(value.trim());
  const id = Number(match?.[1] ?? 0);
  return Number.isSafeInteger(id) && id > 0 ? id : 0;
}

function objectValue(value: unknown): DecisionBody {
  return value && typeof value === "object" && !Array.isArray(value) ? value as DecisionBody : {};
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
