import type { RunnerDatabase } from "../db/database.ts";
import { getIssue } from "../db/repositories/issues.ts";
import type { PiIssueCompletionWatch } from "../db/repositories/pi.ts";
import {
  cancelIssueCompletionAutomation as cancelPiIssueCompletionWatch,
  createIssueCompletionAutomation as createPiIssueCompletionWatch,
  getIssueCompletionAutomation as getPiIssueCompletionWatch,
  listIssueCompletionAutomations
} from "./issueCompletionAutomation.ts";
import {
  cancelSupervisorCommitment,
  containsSupervisorCommitmentMetadata,
  createSupervisorCommitment,
  isSupervisorCommitmentWatch
} from "./supervisorCommitments.ts";

export type IssueCompletionWatchCreateInput = {
  condition?: unknown;
  issue_ids: number[];
  note?: string;
  origin_conversation_id?: string;
  project_id?: string;
  requested_by?: string;
  source_event_id?: string;
  source_message_id?: string;
  target_channel?: string;
  target_chat_id?: string;
  target_message_id?: string;
  target_thread_id?: string;
};
export type IssueCompletionWatchListInput = {
  limit?: number;
  project_id?: string;
  status?: string;
  watch_id?: string;
};
export type IssueCompletionWatchCancelInput = {
  reason?: string;
  watch_id: string;
};

const DEFAULT_WATCH_LIMIT = 20;
const MAX_WATCH_LIMIT = 100;

export function createIssueCompletionWatchAction(
  db: RunnerDatabase,
  input: IssueCompletionWatchCreateInput
) {
  const condition = conditionWithNote(input.condition, input.note);
  const watch = containsSupervisorCommitmentMetadata(condition)
    ? createSupervisorCommitment(db, { ...input, condition }).watch
    : createPiIssueCompletionWatch(db, { ...input, condition });
  return watchActionResult(db, watch);
}

export function listIssueCompletionWatchesAction(
  db: RunnerDatabase,
  input: IssueCompletionWatchListInput
) {
  const watchID = cleanString(input.watch_id);
  if (watchID !== "") return singleWatchResult(db, watchID);
  const watches = listWatches(db, input).map((watch) => watchSummary(db, watch));
  return {
    count: watches.length,
    filters: cleanObject({ project_id: input.project_id, status: input.status }),
    items: watches,
    limit: watchLimit(input.limit)
  };
}

export function cancelIssueCompletionWatchAction(
  db: RunnerDatabase,
  input: IssueCompletionWatchCancelInput
) {
  const current = getPiIssueCompletionWatch(db, input.watch_id);
  if (!current) throw new Error(`PI issue completion watch ${cleanString(input.watch_id)} not found`);
  const forget = forgetReason(input.reason);
  const watch = isSupervisorCommitmentWatch(current)
    ? cancelSupervisorCommitment(db, current.id, {
      actor: "user",
      conversationID: current.origin_conversation_id,
      forget,
      reason: cleanString(input.reason)
    }).watch
    : cancelPiIssueCompletionWatch(db, input.watch_id, cleanString(input.reason) || "cancelled_by_pi_action");
  return watchActionResult(db, watch);
}

export function watchProjectID(db: RunnerDatabase, input: IssueCompletionWatchCreateInput): string {
  const issues = normalizedIssueIDs(input.issue_ids).map((id) => {
    const issue = getIssue(db, id);
    if (!issue) throw new Error(`issue ${id} not found`);
    return issue;
  });
  if (issues.length === 0) throw new Error("issue_ids is required");
  const explicit = cleanString(input.project_id);
  const projectID = explicit || issues[0]?.project_id || "";
  if (projectID === "") throw new Error("project_id is required");
  if (issues.some((issue) => issue.project_id !== projectID)) {
    throw new Error("issue project_id does not match watch");
  }
  return projectID;
}

export function watchProjectIDForCancel(db: RunnerDatabase, watchID: string): string {
  const watch = getPiIssueCompletionWatch(db, watchID);
  if (!watch) throw new Error(`PI issue completion watch ${cleanString(watchID)} not found`);
  return watch.project_id;
}

function singleWatchResult(db: RunnerDatabase, watchID: string) {
  const watch = getPiIssueCompletionWatch(db, watchID);
  if (!watch) throw new Error(`PI issue completion watch ${watchID} not found`);
  return watchActionResult(db, watch);
}

function watchActionResult(db: RunnerDatabase, watch: PiIssueCompletionWatch) {
  return {
    already_satisfied: watchSatisfied(watch),
    current_status: watch.status,
    target: watchTarget(watch),
    target_channel: watchTargetChannel(watch),
    watch_id: watch.id,
    watched_issues: watchedIssues(db, watch),
    watch: watchSummary(db, watch)
  };
}

function watchSummary(db: RunnerDatabase, watch: PiIssueCompletionWatch) {
  return {
    already_satisfied: watchSatisfied(watch),
    completed_at: watch.completed_at,
    created_at: watch.created_at,
    issue_count: watch.items.length,
    project_id: watch.project_id,
    status: watch.status,
    target_channel: watchTargetChannel(watch),
    watch_id: watch.id,
    watched_issues: watchedIssues(db, watch)
  };
}

function watchedIssues(db: RunnerDatabase, watch: PiIssueCompletionWatch) {
  return watch.items.map((item) => {
    const issue = getIssue(db, item.issue_id);
    return {
      id: item.issue_id,
      initial_status: item.initial_status,
      last_status: item.last_status,
      project_id: item.project_id,
      status: issue?.status ?? item.last_status,
      terminal_at: item.terminal_at,
      title: issue?.title ?? ""
    };
  });
}

function listWatches(db: RunnerDatabase, input: IssueCompletionWatchListInput): PiIssueCompletionWatch[] {
  return listIssueCompletionAutomations(db, {
    limit: input.limit,
    projectId: input.project_id,
    status: input.status
  });
}

function conditionWithNote(condition: unknown, note: unknown): unknown {
  const text = cleanString(note);
  if (text === "") return condition;
  return { ...conditionObject(condition), note: text };
}

function conditionObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  const text = cleanString(value);
  if (text === "") return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {}
  return { type: text };
}

function watchTarget(watch: PiIssueCompletionWatch) {
  return {
    channel: watchTargetChannel(watch),
    chat_id: watch.target_chat_id,
    message_id: watch.target_message_id,
    thread_id: watch.target_thread_id
  };
}

function watchTargetChannel(watch: PiIssueCompletionWatch): string {
  return watch.target_channel || (watch.target_chat_id ? "feishu" : "");
}

function watchSatisfied(watch: PiIssueCompletionWatch): boolean {
  return watch.status === "satisfied" || watch.status === "notified";
}

function watchLimit(value: unknown): number {
  const limit = typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : DEFAULT_WATCH_LIMIT;
  return Math.min(limit, MAX_WATCH_LIMIT);
}

function normalizedIssueIDs(value: unknown): number[] {
  const ids = Array.isArray(value) ? value : [value];
  return [...new Set(ids.filter((item): item is number => (
    typeof item === "number" && Number.isSafeInteger(item) && item > 0
  )))];
}

function cleanObject(input: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(Object.entries(input)
    .map(([key, value]) => [key, cleanString(value)])
    .filter(([, value]) => value !== "")) as Record<string, string>;
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function forgetReason(value: unknown): boolean {
  const reason = cleanString(value).toLowerCase();
  return reason === "forget" || reason === "supervisor_commitment_forget" || reason === "forgotten_by_user";
}
