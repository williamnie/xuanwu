import type { RunnerDatabase } from "../db/database.ts";
import {
  rememberPiMemoryItem,
  type PiAction
} from "../db/repositories/pi.ts";
import { createAutomation } from "../db/repositories/automations.ts";
import { createAutomationWatch } from "../db/repositories/automationWatches.ts";
import { createIssueCompletionWatchAction } from "./issueCompletionWatchActions.ts";
import { assertMemoryContentSafe, reusableMemoryRejection } from "./memoryPolicy.ts";
import { INVESTIGATE_WORKFLOW_REF } from "../workflows/investigate.ts";

type JsonObject = Record<string, unknown>;

export function askUserActionResult(action: PiAction, payload: JsonObject): JsonObject {
  const question = firstString(payload.question, payload.prompt, payload.message);
  if (question === "") throw new Error("ask_user question is required");
  return cleanObject({
    action_id: action.id,
    action_type: action.action_type,
    proposal_id: cleanString(payload.proposal_id),
    question,
    reason: cleanString(payload.reason),
    source_item_ids: stringList(payload.source_item_ids),
    status: "needs_user"
  });
}

export function noActionResult(action: PiAction, payload: JsonObject): JsonObject {
  const reason = firstString(payload.reason, payload.summary, payload.title);
  if (reason === "") throw new Error("no_action reason is required");
  return cleanObject({
    action_id: action.id,
    action_type: action.action_type,
    ignored: true,
    proposal_id: cleanString(payload.proposal_id),
    reason,
    status: "ignored"
  });
}

export function createMemoryFromAction(db: RunnerDatabase, action: PiAction, payload: JsonObject): JsonObject {
  const content = firstString(payload.content, payload.summary, payload.title);
  assertMemoryContentSafe(content);
  const kind = firstString(payload.kind, payload.memory_kind);
  const memoryKey = cleanString(payload.memory_key);
  const evidenceRef = firstString(payload.evidence_ref, stringList(payload.evidence_refs)[0]);
  const rejection = reusableMemoryRejection({
    confidence: cleanString(payload.confidence) || confidenceFromRisk(action.risk_level),
    content,
    evidenceRef,
    kind,
    memoryKey,
    scope: cleanString(payload.scope) || "inbox",
    source: "approved_memory_action",
    userAuthorized: cleanString(action.approved_by) !== "" ||
      (action.source === "action_proposal" && cleanString(payload.approved_proposal_by) !== "")
  });
  if (rejection) throw new Error(rejection);
  const item = rememberPiMemoryItem(db, {
    citation_id: cleanString(payload.citation_id) || cleanString(payload.proposal_id),
    citation_label: cleanString(payload.citation_label) || "Supervisor action proposal",
    citation_type: cleanString(payload.citation_type) || "action_proposal",
    citation_url: cleanString(payload.citation_url),
    confidence: cleanString(payload.confidence) || confidenceFromRisk(action.risk_level),
    content,
    disabled: 0,
    id: cleanString(payload.id) || crypto.randomUUID(),
    kind,
    layer: cleanString(payload.layer) || "long_term",
    memory_key: memoryKey,
    memory_type: cleanString(payload.memory_type),
    pinned: flag(payload.pinned),
    scope: cleanString(payload.scope) || "inbox",
    scope_id: memoryScopeID(action, payload),
    source_id: cleanString(payload.source_id) || cleanString(payload.proposal_id) || action.id,
    source_type: cleanString(payload.source_type) || "action_proposal"
  });
  return {
    candidate: false,
    memory: memorySummary(item),
    memory_id: item.id,
    status: "active"
  };
}

export function createReminderFromAction(db: RunnerDatabase, action: PiAction, payload: JsonObject): JsonObject {
  const nextRunAt = firstString(payload.due_at, payload.next_run_at, payload.remind_at);
  if (nextRunAt === "") throw new Error("reminder.create due_at is required");
  const projectID = requiredProjectID(action, payload);
  const audit = proposalAutomationAudit(action, "reminder");
  const automation = createAutomation(db, {
    id: `automation:reminder-${slug(action.id)}-${crypto.randomUUID()}`,
    idempotency_namespace: `reminder:${action.id}`,
    mode: "propose",
    name: firstString(payload.title, payload.summary, "Supervisor reminder"),
    next_run_at: nextRunAt,
    owner: { kind: "project", project_id: projectID },
    permission_policy_ref: `project-policy:${projectID}`,
    status: payload.enabled === false ? "paused" : "active",
    trigger: { type: "manual", config: {} },
    trigger_created_by: audit.actor_id,
    workflow_ref: INVESTIGATE_WORKFLOW_REF
  }, audit.occurred_at, audit);
  return {
    automation_id: automation.id,
    next_run_at: automation.next_run_at,
    reminder_id: automation.id,
    status: automation.status === "active" ? "scheduled" : "paused"
  };
}

export function createWatchThreadFromAction(db: RunnerDatabase, action: PiAction, payload: JsonObject): JsonObject {
  const issueIDs = positiveIDs(payload.issue_ids ?? payload.issue_id);
  if (issueIDs.length > 0) return createIssueWatch(db, action, payload, issueIDs);
  return createThreadMonitor(db, action, payload);
}

function createIssueWatch(db: RunnerDatabase, action: PiAction, payload: JsonObject, issueIDs: number[]): JsonObject {
  return createIssueCompletionWatchAction(db, {
    condition: payload.condition,
    issue_ids: issueIDs,
    note: firstString(payload.note, payload.reason, payload.summary),
    origin_conversation_id: firstString(payload.origin_conversation_id, action.conversation_id),
    project_id: firstString(payload.project_id, action.project_id),
    requested_by: firstString(payload.requested_by, "action_proposal"),
    source_event_id: firstString(payload.source_event_id, firstExternalRef(payload.evidence_refs), cleanString(payload.proposal_id)),
    source_message_id: cleanString(payload.source_message_id),
    target_channel: cleanString(payload.target_channel),
    target_chat_id: cleanString(payload.target_chat_id),
    target_message_id: cleanString(payload.target_message_id),
    target_thread_id: firstString(payload.target_thread_id, payload.thread_id)
  }) as JsonObject;
}

function createThreadMonitor(db: RunnerDatabase, action: PiAction, payload: JsonObject): JsonObject {
  const threadID = firstString(payload.thread_id, payload.target_thread_id, payload.message_id);
  if (threadID === "") throw new Error("watch_thread thread_id or issue_ids is required");
  const projectID = requiredProjectID(action, payload);
  const audit = proposalAutomationAudit(action, "thread-watch");
  const automation = createAutomationWatch(db, {
    allow_empty_notification_target: true,
    condition: {
      event_types: stringList(payload.event_types),
      metadata: { action_id: action.id, proposal_id: cleanString(payload.proposal_id) },
      type: "external_thread_event"
    },
    dedupe_key: `watch-thread:${action.id}`,
    name: firstString(payload.title, payload.summary, `Watch thread ${threadID}`),
    notification_target: {
      channel: "feishu",
      chat_id: cleanString(payload.target_chat_id),
      message_id: cleanString(payload.target_message_id),
      thread_id: firstString(payload.target_thread_id, threadID)
    },
    project_id: projectID,
    subject: { kind: "external_thread", provider: firstString(payload.provider, "feishu"), thread_id: threadID }
  }, audit);
  return {
    automation_id: automation.automation_id,
    monitor_id: automation.automation_id,
    next_run_at: null,
    status: automation.status === "watching" ? "active" : automation.status,
    thread_id: threadID
  };
}

function requiredProjectID(action: PiAction, payload: JsonObject): string {
  const projectID = firstString(payload.project_id, action.project_id);
  if (projectID === "") throw new Error("native Automation requires project_id");
  return projectID;
}

function proposalAutomationAudit(action: PiAction, operation: string) {
  const occurredAt = new Date().toISOString();
  return {
    actor_id: "pi-action-dispatch",
    actor_kind: "supervisor" as const,
    correlation_id: `pi-action:${action.id}`,
    event_id: `automation-event:${operation}:${crypto.randomUUID()}`,
    gate: { authority: "deterministic_policy" as const, decision: "allow" as const, policy_ref: "approved-pi-action-to-automation:v1" },
    occurred_at: occurredAt,
    reason: `approved PI action ${action.id} created native Automation ${operation}`
  };
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "action";
}

function traceFilter(action: PiAction, payload: JsonObject): JsonObject {
  return cleanObject({
    action_id: action.id,
    conversation_id: action.conversation_id,
    project_id: action.project_id,
    proposal_id: cleanString(payload.proposal_id),
    source_item_ids: stringList(payload.source_item_ids)
  });
}

function memoryScopeID(action: PiAction, payload: JsonObject): string {
  return firstString(
    payload.scope_id,
    stringList(payload.source_item_ids)[0],
    action.project_id,
    action.conversation_id,
    "runner"
  );
}

function memorySummary(item: { content: string; disabled: number; id: string; kind: string; scope: string; scope_id: string }) {
  return {
    content: item.content,
    disabled: item.disabled,
    id: item.id,
    kind: item.kind,
    scope: item.scope,
    scope_id: item.scope_id
  };
}

function firstExternalRef(value: unknown): string {
  return stringList(value).find((item) => item.startsWith("external_event:")) || "";
}

function positiveIDs(value: unknown): number[] {
  const values = Array.isArray(value) ? value : [value];
  return [...new Set(values.map(positiveID).filter((item) => item > 0))];
}

function positiveID(value: unknown): number {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
  const parsed = Number.parseInt(cleanString(value), 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
}

function confidenceFromRisk(value: string): string {
  if (value === "high") return "low";
  if (value === "medium") return "medium";
  return "high";
}

function flag(value: unknown): number {
  if (typeof value === "boolean") return value ? 1 : 0;
  return typeof value === "number" && Number.isInteger(value) && value !== 0 ? 1 : 0;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.map(cleanString).filter(Boolean) : [];
}

function firstString(...values: unknown[]): string {
  return values.map(cleanString).find(Boolean) || "";
}

function cleanObject(input: JsonObject): JsonObject {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => {
    if (value === undefined || value === "" || value === 0) return false;
    return !Array.isArray(value) || value.length > 0;
  }));
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
