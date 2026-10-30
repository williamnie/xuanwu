import type { RunnerDatabase } from "../../db/database.ts";
import { listPersistedAttention } from "../../domain/attention/persistence.ts";
import { getPiAction, getPiGuardianAlert } from "../../db/repositories/pi.ts";
import type { AttentionRecord } from "../../domain/attention/contracts.ts";
import { json } from "../errors.ts";
import { guardianAlertPresentation } from "../../pi/guardian/guardianAlertPresentation.ts";
import { type InboxItem } from "./commandCenterInbox.ts";
import { attentionIsVisible, piActionAttentionDetails, DEFAULT_LIMIT, MAX_LIMIT, COMMAND_CENTER_SECTIONS, SUMMARY_TEXT_LIMIT } from "./commandCenterApi.piActionAttentionDetails.ts";
import type { CommandCenterSectionName, CommandCenterFreshness } from "./commandCenterApi.model.ts";

export function readInboxAttention(db: RunnerDatabase, now: Date): InboxItem[] {
  return listPersistedAttention(db, { unbounded: true, visibleInboxOnly: true, now })
    .filter(item => attentionIsVisible(item, now) && attentionHandling(db, item, now) === "user_action_required")
    .map(item => {
      const refs = [...item.related_refs, ...item.source_refs.flatMap(ref => ref.correlation_refs)];
      const issue = refs.map(ref => /^issue:([1-9]\d*)$/.exec(ref)?.[1]).find(Boolean);
      const work = refs.find(ref => /^work:xw:work:issues:[1-9]\d*$/.test(ref));
      return {
        key: `attention:${item.id}`, source: "attention", actionable: true,
        occurred_at: item.updated_at, attention_id: item.id,
        work_id: work?.slice(5) ?? (issue ? `xw:work:issues:${issue}` : null),
        project_id: item.owner.kind === "project" ? item.owner.project_id : null,
        attention: attentionSummary(db, item, now)
      };
    });
}

export function attentionSummary(db: RunnerDatabase, item: AttentionRecord, now = new Date()): Record<string, unknown> {
  const primary = item.source_refs[0];
  return {
    created_at: item.created_at,
    id: item.id,
    links: {
      action: `/api/command-center/attention/${encodeURIComponent(item.id)}/actions`,
      self: attentionSourceLink(primary.authority, primary.local_id),
      view: primary.authority === "attention_inbox_items" ? "#/attention-inbox" : "#/command-center"
    },
    details: attentionDetails(db, item, now),
    next_action: item.next_action,
    priority: item.priority,
    required_actor: item.required_actor,
    revision: item.revision,
    snoozed_until: item.snoozed_until,
    source_refs: item.source_refs,
    status: item.status,
    summary: boundedText(item.summary),
    type: item.type,
    updated_at: item.updated_at,
    severity: item.severity
  };
}

export function attentionHandling(db: RunnerDatabase, item: AttentionRecord, now: Date): string {
  return attentionDetails(db, item, now).handling as string;
}

export function attentionDetails(db: RunnerDatabase, item: AttentionRecord, now: Date): Record<string, unknown> {
  const guardianRef = item.source_refs.find((ref) => ref.authority === "pi_guardian_alerts");
  const guardian = guardianRef ? getPiGuardianAlert(db, guardianRef.local_id) : null;
  if (guardian) {
    return {
      ...guardianAlertPresentation(guardian, now),
      diagnostic: item.summary,
      reason_code: item.reason_code,
      source: "PI Guardian"
    };
  }
  const actionRef = item.source_refs.find((ref) => ref.authority === "pi_actions");
  const action = actionRef ? getPiAction(db, actionRef.local_id) : null;
  if (action) return piActionAttentionDetails(db, action, item, now);
  const projectID = item.owner.kind === "project" ? item.owner.project_id : "";
  return {
    active: item.status !== "resolved" && item.status !== "dismissed",
    component: attentionComponent(item.type),
    description: attentionDescription(item.type),
    diagnostic: item.summary,
    first_seen_at: item.created_at,
    handling: "user_action_required",
    historical: false,
    last_seen_at: item.updated_at,
    location: projectID ? `项目 ${projectID}` : "Runner 系统",
    pi_action: "PI 已整理来源事实，并在你决定前保持业务状态不变。",
    pi_can_handle: false,
    requires_user: true,
    state_label: "当前事项 · 需要你处理",
    title: attentionTitle(item.type, item.summary),
    user_action: attentionUserAction(item.type),
    source: item.source_refs[0]?.authority ?? "Attention"
  };
}

export function attentionComponent(type: string): string {
  if (type === "approval_required") return "Action Gate";
  if (type === "input_required") return "PI 对话";
  if (type === "verification_required") return "验收门禁";
  if (type === "connection_issue") return "连接与 Provider";
  return "Work Runtime";
}

export function attentionDescription(type: string): string {
  if (type === "approval_required") return "有一项可能改变外部状态或执行结果的操作，必须由你决定。";
  if (type === "input_required") return "PI 缺少继续执行所需的信息，无法安全地自行猜测。";
  if (type === "verification_required") return "工作已经产出结果，但还缺少你的验收或必要证据。";
  if (type === "connection_issue") return "连接或 Provider 不可用，PI 已停止可能产生重复副作用的操作。";
  return "当前故障或阻塞无法在自动恢复预算内解决。";
}

export function attentionTitle(type: string, summary: string): string {
  if (type === "approval_required") return "需要你决定一项操作";
  if (type === "input_required") return "PI 需要你补充信息";
  if (type === "verification_required") return "结果等待你的验收";
  if (type === "connection_issue") return "连接问题需要人工处理";
  return boundedText(summary);
}

export function attentionUserAction(type: string): string {
  if (type === "approval_required") return "审阅操作内容和风险，然后批准或拒绝。";
  if (type === "input_required") return "打开来源并回答 PI 提出的问题。";
  if (type === "verification_required") return "查看交付证据并确认通过，或说明需要修改的内容。";
  if (type === "connection_issue") return "检查对应连接配置；恢复后 PI 会继续执行。";
  return "打开来源查看失败事实，决定重试、修改或停止。";
}

export function attentionSourceLink(authority: string, localID: string): string {
  if (authority === "attention_inbox_items") return `/api/pi/attention-inbox/items/${encodeURIComponent(localID)}`;
  if (authority === "pi_guardian_alerts") return `/api/pi/guardian/alerts/${encodeURIComponent(localID)}`;
  if (authority === "pi_approval_requests") return "/api/pi/approval-requests?status=open";
  return "/api/issues";
}

export function requestInput(request: Request): { limit: number; sections: CommandCenterSectionName[] } {
  const params = new URL(request.url).searchParams;
  const rawLimit = params.get("limit")?.trim() ?? "";
  const limit = rawLimit === "" ? DEFAULT_LIMIT : Number(rawLimit);
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > MAX_LIMIT) {
    throw new CommandCenterHttpError(400, "invalid_limit", `limit must be an integer from 1 to ${MAX_LIMIT}`);
  }
  const rawSections = params.getAll("sections").flatMap((value) => value.split(","))
    .map((value) => value.trim()).filter(Boolean);
  const sections = rawSections.length === 0
    ? [...COMMAND_CENTER_SECTIONS]
    : [...new Set(rawSections.map(commandCenterSection))];
  return { limit, sections };
}

export function commandCenterSection(value: string): CommandCenterSectionName {
  if (COMMAND_CENTER_SECTIONS.includes(value as CommandCenterSectionName)) return value as CommandCenterSectionName;
  throw new CommandCenterHttpError(400, "invalid_section", `unknown Command Center section: ${value}`);
}

export function freshness(now: Date, timestamps: string[], staleAfterSeconds: number): CommandCenterFreshness {
  const sourceUpdatedAt = timestamps.filter(validTimestamp).sort().at(-1) ?? "";
  if (sourceUpdatedAt === "") {
    return {
      is_stale: false,
      queried_at: now.toISOString(),
      source_updated_at: "",
      stale_after_seconds: staleAfterSeconds,
      state: "empty"
    };
  }
  const stale = now.getTime() - Date.parse(sourceUpdatedAt) > staleAfterSeconds * 1000;
  return {
    is_stale: stale,
    queried_at: now.toISOString(),
    source_updated_at: sourceUpdatedAt,
    stale_after_seconds: staleAfterSeconds,
    state: stale ? "stale" : "current"
  };
}

export function validTimestamp(value: string): boolean {
  return value.trim() !== "" && Number.isFinite(Date.parse(value));
}

export function boundedText(value: string): string {
  return value.length <= SUMMARY_TEXT_LIMIT ? value : `${value.slice(0, SUMMARY_TEXT_LIMIT - 1)}…`;
}

export class CommandCenterHttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

export async function commandCenterResponse(read: () => unknown | Promise<unknown>): Promise<Response> {
  try {
    return json(await read());
  } catch (error) {
    if (error instanceof CommandCenterHttpError) {
      return json({ code: error.code, message: error.message }, { status: error.status });
    }
    throw error;
  }
}
