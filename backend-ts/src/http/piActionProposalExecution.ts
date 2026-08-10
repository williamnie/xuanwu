import type { RunnerDatabase } from "../db/database.ts";
import { getExternalEvent } from "../db/repositories/externalEvents.ts";
import { getAttentionInboxItem, updateAttentionInboxItemStatus } from "../db/repositories/intakeRuns.ts";
import {
  approveActionProposal,
  getActionProposal,
  getPiAction,
  updateActionProposalActions,
  type ActionProposalAction,
  type ActionProposalRecord,
  type PiAction
} from "../db/repositories/pi.ts";
import { createPendingPiAction, recordPiActionAuditEvent } from "../pi/actionEngine.ts";
import { decideSourcePermission, type SourcePermissionDecision } from "../pi/sourcePermissionPolicy.ts";
import { executeApprovedPiAction, resolvePiActionDecision, type PiActionDecisionContext } from "./piActionDecision.ts";
import { HttpError } from "./errors.ts";

type JsonObject = Record<string, unknown>;
type ActionEditMap = Record<string, { payload?: JsonObject }>;
type ProposalExecutionContext = PiActionDecisionContext & { database: RunnerDatabase };

type ExecuteProposalInput = {
  actionEdits?: ActionEditMap;
  actor?: string;
  proposalID: string;
};

type ExecutionSummary = {
  error?: string;
  execution_status: string;
  pi_action_id: string;
  result?: JsonObject;
};

export async function approveAndExecuteActionProposal(
  context: ProposalExecutionContext,
  input: ExecuteProposalInput
): Promise<ActionProposalRecord & { executions: ExecutionSummary[] }> {
  const existing = requireProposal(context.database, input.proposalID);
  const editable = existing.status === "proposed"
    ? updateActionProposalActions(context.database, existing.id, editedActions(existing, input.actionEdits))
    : existing;
  const approved = editable.status === "approved"
    ? editable
    : approveActionProposal(context.database, editable.id, cleanString(input.actor) || "user");
  const executions: ExecutionSummary[] = [];
  for (const action of approved.actions) executions.push(await executeProposalAction(context, approved, action, input.actor));
  const updated = updateActionProposalActions(context.database, approved.id, withExecution(approved.actions, executions));
  markSourceItems(context.database, updated, executions);
  return { ...updated, executions };
}

function requireProposal(db: RunnerDatabase, id: string): ActionProposalRecord {
  const proposal = getActionProposal(db, id);
  if (!proposal) throw new HttpError(404, "action proposal not found");
  if (proposal.status === "rejected") throw new HttpError(409, "action proposal already rejected");
  return proposal;
}

function editedActions(proposal: ActionProposalRecord, edits: ActionEditMap = {}): ActionProposalAction[] {
  return proposal.actions.map((action) => {
    const patch = edits[action.id]?.payload;
    return patch ? { ...action, payload: { ...action.payload, ...patch } } : action;
  });
}

async function executeProposalAction(
  context: ProposalExecutionContext,
  proposal: ActionProposalRecord,
  action: ActionProposalAction,
  actor = "user"
): Promise<ExecutionSummary> {
  const payload = executablePayload(context.database, proposal, action);
  const permission = sourcePermission(proposal, action, payload);
  const created = createPendingPiAction(context.database, {
    bus: context.bus,
    source: "action_proposal"
  }, {
    actionType: action.type,
    authorization: undefined,
    idempotencyKey: `action-proposal:${proposal.id}:${action.id}`,
    issueID: positiveID(payload.issue_id),
    payload,
    projectID: projectID(action, payload),
    rationale: action.rationale || proposal.summary,
    riskOverride: { requiresConfirmation: requiresConfirmation(action, permission), riskLevel: action.risk }
  }) as { action_id?: string };
  const actionID = cleanString(created.action_id);
  recordSourcePolicyDecision(context.database, getPiAction(context.database, actionID), permission);
  const final = await finishAction(context, actionID, cleanString(actor) || "user");
  return summaryFromAction(final);
}

async function finishAction(context: ProposalExecutionContext, id: string, actor: string): Promise<PiAction> {
  const current = getPiAction(context.database, id);
  if (!current) throw new HttpError(500, "PI action missing after proposal execution enqueue");
  if (current.status === "pending") return await resolvePiActionDecision(context, { actionID: id, actor, decision: "approve" });
  if (current.status === "approved") return await executeApprovedPiAction(context, id);
  return current;
}

function executablePayload(
  db: RunnerDatabase,
  proposal: ActionProposalRecord,
  action: ActionProposalAction
): JsonObject {
  const payload = { ...action.payload };
  if (action.type === "issue.create") return issueCreatePayload(proposal, action, payload);
  if (action.type === "message.reply_draft" || action.type === "message.reply_send") {
    return replyPayload(db, proposal, action, payload);
  }
  if (action.type === "issue.status_lookup") return withProjectHint(action, payload);
  if (action.type === "memory.create") return withProposalTrace(proposal, action, {
    ...payload,
    approved_proposal_by: proposal.approved_by
  });
  return withProposalTrace(proposal, action, payload);
}

function withProposalTrace(
  proposal: ActionProposalRecord,
  action: ActionProposalAction,
  payload: JsonObject
): JsonObject {
  return {
    ...payload,
    evidence_refs: [...new Set([...stringList(payload.evidence_refs), ...action.evidence_refs, ...proposal.evidence_refs])],
    proposal_id: proposal.id,
    proposal_ref: `proposal:${proposal.id}`,
    source_item_ids: proposal.source_item_ids
  };
}

function issueCreatePayload(proposal: ActionProposalRecord, action: ActionProposalAction, payload: JsonObject): JsonObject {
  const sourceItem = proposal.source_item_ids[0] || "";
  const description = cleanString(payload.description) || cleanString(payload.body) || proposal.summary;
  return {
    ...payload,
    description,
    project_id: projectID(action, payload),
    source_excerpt: [`proposal:${proposal.id}`, ...proposal.evidence_refs].filter(Boolean).join("\n"),
    source_turn_id: sourceItem,
    status: cleanString(payload.status) || "triage"
  };
}

function replyPayload(
  db: RunnerDatabase,
  proposal: ActionProposalRecord,
  action: ActionProposalAction,
  payload: JsonObject
): JsonObject {
  const event = firstExternalEvent(db, [...stringList(payload.evidence_refs), ...action.evidence_refs, ...proposal.evidence_refs]);
  const normalized = objectValue(event?.normalized_message);
  const conversation = objectValue(normalized.conversation);
  const thread = objectValue(normalized.thread);
  const sender = objectValue(normalized.sender);
  return {
    ...payload,
    content: replyText(payload),
    external_event_id: positiveID(payload.external_event_id) || event?.id || 0,
    risk: action.risk,
    source: cleanString(payload.source) || event?.source || "action_proposal",
    actor: cleanString(payload.actor) || firstString(
      sender.id, normalized.actor_id, normalized.actorId, normalized.sender_id,
      normalized.senderId, normalized.user_id, normalized.userId, event?.actor
    ),
    target_person_id: cleanString(payload.target_person_id) || firstString(
      sender.id, normalized.person_id, normalized.personId, normalized.sender_id,
      normalized.senderId, normalized.user_id, normalized.userId, event?.actor
    ),
    target_chat_id: cleanString(payload.target_chat_id) || firstString(normalized.chat_id, normalized.chatId, conversation.id),
    target_message_id: cleanString(payload.target_message_id) || firstString(normalized.message_id, normalized.messageId, event?.external_id),
    target_thread_id: cleanString(payload.target_thread_id) || firstString(normalized.thread_id, normalized.threadId, thread.id)
  };
}

function withProjectHint(action: ActionProposalAction, payload: JsonObject): JsonObject {
  const project = projectID(action, payload);
  return project === "" ? payload : { ...payload, project_id: project };
}

function sourcePermission(
  proposal: ActionProposalRecord,
  action: ActionProposalAction,
  payload: JsonObject
): SourcePermissionDecision | undefined {
  if (!sourcePolicyAction(action.type)) return undefined;
  return decideSourcePermission({
    actionRisk: action.risk,
    actionType: action.type,
    actor: cleanString(payload.actor),
    automation: cleanString(payload.automation_id ?? payload.automation),
    chat: cleanString(payload.target_chat_id),
    issuePolicy: objectValue(payload.issue_policy),
    person: cleanString(payload.target_person_id),
    payload,
    projectConfirmed: payload.project_confirmed === true,
    replyPolicy: replyPolicyInput(payload),
    skill: cleanString(payload.skill_id) || proposal.skill_run_id,
    source: cleanString(payload.source),
    sourcePolicy: objectValue(payload.source_policy),
    tool: cleanString(payload.tool) || action.type
  });
}

function sourcePolicyAction(type: string): boolean {
  return type === "message.reply_send" || type === "issue.create" ||
    type === "issue.enqueue" || type === "issue.schedule_enqueue";
}

function replyPolicyInput(payload: JsonObject): JsonObject {
  const direct = objectValue(payload.reply_policy ?? payload.policy);
  if (payload.auto_reply_enabled !== true) return direct;
  return { ...direct, auto_reply_enabled: true };
}

function requiresConfirmation(
  action: ActionProposalAction,
  decision: SourcePermissionDecision | undefined
): boolean {
  if (decision?.canAutoExecute === true && issuePolicyAction(action.type)) return false;
  return action.requires_approval || decision?.requiresApproval === true;
}

function issuePolicyAction(type: string): boolean {
  return type === "issue.create" || type === "issue.enqueue" || type === "issue.schedule_enqueue";
}

function recordSourcePolicyDecision(
  db: RunnerDatabase,
  action: PiAction | null,
  decision: SourcePermissionDecision | undefined
): void {
  if (!action || !decision) return;
  recordPiActionAuditEvent(db, action, "source_policy_decision", {
    actor: "source_policy",
    decision: decision.canAutoExecute ? "execute" : "ask",
    payload: decision.audit,
    reason: decision.reason
  });
}

function summaryFromAction(action: PiAction): ExecutionSummary {
  const result = objectValue(parseJson(action.result_json));
  return {
    error: cleanString(result.error) || undefined,
    execution_status: action.status,
    pi_action_id: action.id,
    result: Object.keys(result).length > 0 ? result : undefined
  };
}

function withExecution(actions: ActionProposalAction[], executions: ExecutionSummary[]): ActionProposalAction[] {
  return actions.map((action, index) => ({ ...action, ...executions[index] }));
}

function markSourceItems(db: RunnerDatabase, proposal: ActionProposalRecord, executions: ExecutionSummary[]): void {
  const status = sourceItemStatus(proposal.actions, executions);
  for (const id of proposal.source_item_ids.map(attentionItemID).filter(Boolean)) {
    if (getAttentionInboxItem(db, id)) updateAttentionInboxItemStatus(db, id, status);
  }
}

function sourceItemStatus(
  actions: ActionProposalAction[],
  executions: ExecutionSummary[]
): "actioned" | "failed" | "ignored" {
  if (executions.some((item) => item.execution_status === "failed")) return "failed";
  if (actions.length > 0 && actions.every((action) => action.type === "no_action")) {
    return executions.every((item) => item.execution_status === "completed") ? "ignored" : "failed";
  }
  return executions.some((item) => item.execution_status === "completed") ? "actioned" : "failed";
}

function firstExternalEvent(db: RunnerDatabase, refs: string[]) {
  for (const id of refs.map(externalEventID).filter(Boolean)) {
    const event = getExternalEvent(db, id);
    if (event) return event;
  }
  return null;
}

function projectID(action: ActionProposalAction, payload: JsonObject): string {
  return cleanString(payload.project_id) || cleanString(action.target_hints.find((hint) => hint.kind === "project")?.id);
}

function replyText(payload: JsonObject): string {
  return cleanString(payload.content) || cleanString(payload.draft) || cleanString(payload.text) || cleanString(payload.message);
}

function attentionItemID(value: string): number {
  return refID(value, /^attention_inbox_item:(\d+)$/);
}

function externalEventID(value: string): number {
  return refID(value, /^external_event:(\d+)$/);
}

function refID(value: string, pattern: RegExp): number {
  const match = pattern.exec(value);
  return match ? positiveID(match[1]) : 0;
}

function positiveID(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(cleanString(value), 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
}

function objectValue(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function parseJson(value: string): unknown {
  try { return JSON.parse(value || "{}"); } catch { return {}; }
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.map(cleanString).filter(Boolean) : [];
}

function firstString(...values: unknown[]): string {
  return values.map(cleanString).find(Boolean) || "";
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
