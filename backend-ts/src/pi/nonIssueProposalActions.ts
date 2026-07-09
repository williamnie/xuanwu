import type { RunnerDatabase } from "../db/database.ts";
import {
  createPiMemoryItem,
  type PiAction
} from "../db/repositories/pi.ts";
import { createPiAutomation } from "../db/repositories/piAutomations.ts";
import { createIssueCompletionWatchAction } from "./issueCompletionWatchActions.ts";
import { assertMemoryContentSafe } from "./memoryPolicy.ts";

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
  const item = createPiMemoryItem(db, {
    citation_id: cleanString(payload.citation_id) || cleanString(payload.proposal_id),
    citation_label: cleanString(payload.citation_label) || "PI action proposal",
    citation_type: cleanString(payload.citation_type) || "action_proposal",
    citation_url: cleanString(payload.citation_url),
    confidence: cleanString(payload.confidence) || confidenceFromRisk(action.risk_level),
    content,
    disabled: memoryDisabled(payload),
    id: cleanString(payload.id) || crypto.randomUUID(),
    kind: firstString(payload.kind, payload.memory_kind, "note"),
    layer: cleanString(payload.layer) || "working",
    memory_type: cleanString(payload.memory_type),
    pinned: flag(payload.pinned),
    scope: cleanString(payload.scope) || "inbox",
    scope_id: memoryScopeID(action, payload),
    source_id: cleanString(payload.source_id) || cleanString(payload.proposal_id) || action.id,
    source_type: cleanString(payload.source_type) || "action_proposal"
  });
  return {
    candidate: item.disabled === 1,
    memory: memorySummary(item),
    memory_id: item.id,
    status: item.disabled === 1 ? "candidate" : "active"
  };
}

export function createReminderFromAction(db: RunnerDatabase, action: PiAction, payload: JsonObject): JsonObject {
  const nextRunAt = firstString(payload.due_at, payload.next_run_at, payload.remind_at);
  if (nextRunAt === "") throw new Error("reminder.create due_at is required");
  const automation = createPiAutomation(db, {
    enabled: payload.enabled !== false,
    filters: [traceFilter(action, payload)],
    max_actions_per_run: 1,
    mode: "draft",
    name: firstString(payload.title, payload.summary, "PI reminder"),
    next_run_at: nextRunAt,
    source_policy: { external_writes: false, proposal_id: cleanString(payload.proposal_id) },
    steps: [{
      cursor: "",
      idempotency_key: `reminder:${action.id}`,
      skill_id: cleanString(payload.skill_id) || "pi.reminder.follow_up",
      type: "domain_skill",
      watermark: ""
    }],
    trigger: {
      due_at: nextRunAt,
      kind: "reminder",
      proposal_id: cleanString(payload.proposal_id),
      type: "schedule"
    },
    trigger_type: "schedule"
  });
  return {
    automation_id: automation.id,
    next_run_at: automation.next_run_at,
    reminder_id: `automation:${automation.id}`,
    status: automation.enabled ? "scheduled" : "paused"
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
  const automation = createPiAutomation(db, {
    enabled: payload.enabled !== false,
    filters: [traceFilter(action, payload)],
    max_actions_per_run: 1,
    mode: "propose",
    name: firstString(payload.title, payload.summary, `Watch thread ${threadID}`),
    source_policy: { external_writes: false, proposal_id: cleanString(payload.proposal_id) },
    steps: [{
      cursor: "",
      idempotency_key: `watch_thread:${action.id}`,
      skill_id: cleanString(payload.skill_id),
      type: "source_sync",
      watermark: ""
    }],
    trigger: {
      every: firstString(payload.every, payload.interval, "1h"),
      kind: "watch_thread",
      thread_id: threadID,
      type: "continuous"
    },
    trigger_type: "continuous"
  });
  return {
    automation_id: automation.id,
    monitor_id: `automation:${automation.id}`,
    next_run_at: automation.next_run_at,
    status: automation.enabled ? "active" : "paused",
    thread_id: threadID
  };
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

function memoryDisabled(payload: JsonObject): number {
  if (payload.disabled === 0 || payload.disabled === false) return 0;
  if (payload.active === true || cleanString(payload.status) === "active") return 0;
  return 1;
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
