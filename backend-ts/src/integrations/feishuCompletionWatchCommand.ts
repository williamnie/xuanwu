import type { RunnerDatabase } from "../db/database.ts";
import { getIssue, listIssues, type Issue } from "../db/repositories/issues.ts";
import { listProjects } from "../db/repositories/projects.ts";
import {
  createIssueCompletionAutomation as createPiIssueCompletionWatch,
  ISSUE_COMPLETION_TERMINAL_STATUSES
} from "../pi/issueCompletionAutomation.ts";
import type { FeishuNormalizedMessageEvent } from "./feishu.ts";
import type { FeishuConversationRoute } from "./feishuConversationRouting.ts";
import type { FeishuProjectContextResult } from "./feishuProjectContext.ts";

export type FeishuCompletionWatchCommandInput = {
  event: FeishuNormalizedMessageEvent;
  projectContext: FeishuProjectContextResult;
  route: FeishuConversationRoute;
  sourceEventId: string;
  text: string;
};
export type FeishuCompletionWatchCommandResult =
  | { handled: false }
  | { handled: true; projectId: string; reason: string; text: string };

type ProjectIssues = { issues: Issue[]; projectId: string };
type ResolveResult =
  | { kind: "ready"; issues: Issue[]; projectId: string }
  | { kind: "reply"; projectId?: string; reason: string; text: string };

const TERMINAL_STATUSES = [...ISSUE_COMPLETION_TERMINAL_STATUSES];
const NOTIFY_RE = /(通知|提醒|告诉|叫我|notify|remind)/i;
const FINISH_RE = /(做完|完成|结束|都好了|finish|finished|done|complete|completed)/i;
const ISSUE_RE = /#\s*\d+|issues?|任务|工单/i;

export function applyFeishuCompletionWatchCommand(
  db: RunnerDatabase,
  input: FeishuCompletionWatchCommandInput
): FeishuCompletionWatchCommandResult {
  const text = clean(input.text);
  if (!isCompletionWatchIntent(text)) return { handled: false };
  const resolved = resolveWatchIssues(db, input.projectContext, text);
  if (resolved.kind === "reply") return { handled: true, projectId: resolved.projectId ?? "", reason: resolved.reason, text: resolved.text };
  const expected = statedIssueCount(text);
  if (expected > 0 && expected !== resolved.issues.length) {
    return countMismatchReply(resolved.projectId, resolved.issues, expected);
  }
  return createdReply(db, input, resolved);
}

function isCompletionWatchIntent(text: string): boolean {
  return text !== "" && NOTIFY_RE.test(text) && FINISH_RE.test(text) && ISSUE_RE.test(text);
}

function resolveWatchIssues(
  db: RunnerDatabase,
  context: FeishuProjectContextResult,
  text: string
): ResolveResult {
  const explicit = explicitIssues(db, text);
  if (explicit.ids.length > 0) return explicitIssuesResult(explicit);
  const candidates = projectsWithUnfinishedIssues(db);
  if (shouldAskProject(context, candidates)) return projectClarification(candidates);
  const projectId = context.status === "resolved" ? context.projectId : candidates[0]?.projectId ?? "";
  if (projectId === "") return reply("completion_watch_project_clarification", "请告诉我是哪个项目，或直接发 issue id（例如：等 #542 #543 做完通知我）。");
  const issues = unfinishedIssues(db, projectId);
  if (issues.length === 0) return reply("completion_watch_no_unfinished", `项目 ${projectId} 当前没有需要等待完成的 issue。`, projectId);
  return { kind: "ready", issues, projectId };
}

function explicitIssues(db: RunnerDatabase, text: string): { ids: number[]; issues: Issue[]; missing: number[] } {
  const ids = issueRefs(text);
  const issues = ids.map((id) => getIssue(db, id)).filter((issue): issue is Issue => Boolean(issue));
  const found = new Set(issues.map((issue) => issue.id));
  return { ids, issues, missing: ids.filter((id) => !found.has(id)) };
}

function explicitIssuesResult(input: { ids: number[]; issues: Issue[]; missing: number[] }): ResolveResult {
  if (input.missing.length > 0) {
    return reply("completion_watch_issue_missing", `找不到这些 issue：${formatIssueIDs(input.missing)}。请确认 id 后再发我。`);
  }
  const projectIDs = [...new Set(input.issues.map((issue) => issue.project_id))];
  if (projectIDs.length !== 1) {
    return reply("completion_watch_project_clarification", `这些 issue 分属多个项目：${projectIDs.join("、")}。请按项目分别发起完成提醒。`);
  }
  return { kind: "ready", issues: input.issues, projectId: projectIDs[0] ?? "" };
}

function shouldAskProject(context: FeishuProjectContextResult, candidates: ProjectIssues[]): boolean {
  if (context.status === "ambiguous") return true;
  if (context.status !== "resolved") return candidates.length > 1;
  if (context.source === "mapping_default") return candidates.length > 1;
  return false;
}

function projectClarification(candidates: ProjectIssues[]): ResolveResult {
  if (candidates.length === 0) {
    return reply("completion_watch_project_clarification", "我没有找到任何项目还有未完成 issue。请指定 issue id 或项目名后再试。", "");
  }
  const options = candidates.map((item) => `${item.projectId}(${item.issues.length})`).join("、");
  return reply("completion_watch_project_clarification", `多个项目还有未完成 issue：${options}。请指定项目名或 issue id，我再创建完成提醒。`);
}

function countMismatchReply(projectId: string, issues: Issue[], expected: number): FeishuCompletionWatchCommandResult {
  const ids = formatIssueIDs(issues.map((issue) => issue.id));
  return {
    handled: true,
    projectId,
    reason: "completion_watch_count_confirmation",
    text: `你说的是 ${expected} 个，但项目 ${projectId} 当前找到 ${issues.length} 个未完成 issue：${ids}。请确认要等待这些 issue，或直接发“等 ${ids} 做完通知我”。`
  };
}

function createdReply(
  db: RunnerDatabase,
  input: FeishuCompletionWatchCommandInput,
  resolved: { issues: Issue[]; projectId: string }
): FeishuCompletionWatchCommandResult {
  const watch = createPiIssueCompletionWatch(db, watchInput(input, resolved));
  const ids = watch.items.map((item) => item.issue_id);
  return {
    handled: true,
    projectId: watch.project_id,
    reason: "completion_watch_created",
    text: [
      "已创建完成提醒。",
      `watch_id: ${watch.id}`,
      `issue ids: ${formatIssueIDs(ids)}`,
      `current status: ${watch.status}`,
      `trigger condition: all watched issues reach terminal status (${TERMINAL_STATUSES.join(", ")})`,
      `current issue status: ${statusLine(resolved.issues)}`
    ].join("\n")
  };
}

function watchInput(input: FeishuCompletionWatchCommandInput, resolved: { issues: Issue[]; projectId: string }) {
  return {
    condition: { pending_verification_satisfies: true, source: "feishu_natural_language", terminal_statuses: TERMINAL_STATUSES, type: "all_terminal" },
    issue_ids: resolved.issues.map((issue) => issue.id),
    origin_conversation_id: input.route.conversationId,
    project_id: resolved.projectId,
    requested_by: input.event.sender.id || input.event.sender.open_id,
    source_event_id: input.sourceEventId || input.event.dedupe_key,
    source_message_id: input.event.message_id,
    target_channel: "feishu",
    target_chat_id: input.event.chat_id,
    target_message_id: input.event.message_id,
    target_thread_id: input.event.thread_id || input.event.root_id
  };
}

function projectsWithUnfinishedIssues(db: RunnerDatabase): ProjectIssues[] {
  return listProjects(db)
    .map((project) => ({ projectId: project.id, issues: unfinishedIssues(db, project.id) }))
    .filter((item) => item.issues.length > 0);
}

function unfinishedIssues(db: RunnerDatabase, projectId: string): Issue[] {
  return listIssues(db, { projectId }).filter((issue) => !ISSUE_COMPLETION_TERMINAL_STATUSES.has(issue.status));
}

function statedIssueCount(text: string): number {
  const match = text.match(/(?:还有|剩下|剩余|有)?\s*([0-9０-９一二两三四五六七八九十两]+)\s*个?\s*(?:issues?|任务|工单)/i);
  return match ? numberText(match[1] ?? "") : 0;
}

function issueRefs(text: string): number[] {
  const refs: number[] = [];
  for (const match of text.matchAll(/#\s*(\d+)/g)) refs.push(Number.parseInt(match[1] ?? "", 10));
  return [...new Set(refs.filter((id) => Number.isSafeInteger(id) && id > 0))];
}

function numberText(text: string): number {
  const normalized = text.replace(/[０-９]/g, (char) => String(char.charCodeAt(0) - 0xFF10));
  const direct = Number.parseInt(normalized, 10);
  if (Number.isSafeInteger(direct) && direct > 0) return direct;
  return chineseNumber(normalized);
}

function chineseNumber(text: string): number {
  const digits: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (text === "十") return 10;
  const ten = text.match(/^([一二两三四五六七八九])?十([一二两三四五六七八九])?$/);
  if (ten) return (digits[ten[1] ?? ""] ?? 1) * 10 + (digits[ten[2] ?? ""] ?? 0);
  return digits[text] ?? 0;
}

function reply(reason: string, text: string, projectId = ""): ResolveResult {
  return { kind: "reply", projectId, reason, text };
}

function formatIssueIDs(ids: number[]): string {
  return ids.map((id) => `#${id}`).join(", ");
}

function statusLine(issues: Issue[]): string {
  return issues.map((issue) => `#${issue.id} ${issue.status}`).join("; ");
}

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
