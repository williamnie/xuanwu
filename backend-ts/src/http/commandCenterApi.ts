import type { RunnerDatabase } from "../db/database.ts";
import { readWorkSummary } from "../db/repositories/workSummary.ts";
import {
  countStoredHandoffs,
  listStoredHandoffs,
  type StoredHandoffRecord
} from "../db/repositories/handoffs.ts";
import {
  getPersistedAttention,
  listPersistedAttention,
  persistAttentionCommand
} from "../domain/attention/persistence.ts";
import {
  getActionProposal,
  getPiAction,
  getPiApprovalRequest,
  getPiGuardianAlert,
  type PiAction
} from "../db/repositories/pi.ts";
import type { AttentionCommand, AttentionRecord, AttentionTransitionAudit } from "../domain/attention/contracts.ts";
import { eventProjectionStatusForRead } from "../db/repositories/compactEventSummaryProjection.ts";
import {
  countRunsByStatus,
  listLatestRunsForWorkIDs,
  type RunView
} from "../db/repositories/runs.ts";
import {
  countIssueBackedWorks,
  listIssueBackedWorks,
  workIDToIssueID
} from "../domain/work/issueAdapter.ts";
import { getIssue } from "../db/repositories/issues.ts";
import type { WorkLedgerEntry, WorkStatus } from "../domain/work/contracts.ts";
import { readIssueReadiness } from "../domain/readiness/contracts.ts";
import { makeDomainID } from "../xuanwu/coreDomainContracts.ts";
import { HttpError, json, parseJsonBody } from "./errors.ts";
import type { ReadApiContext } from "./readApiContext.ts";
import type { Router } from "./router.ts";
import { resolveAttentionDecision } from "./attentionDecisionService.ts";
import { guardianAlertPresentation } from "../pi/guardianAlertPresentation.ts";
import { handoffHref } from "../notifications/handoffNotifier.ts";
import {
  guardianOperationsSnapshot,
  latestGuardianOperationsReport
} from "../pi/guardianOperationsDailyReport.ts";

export const COMMAND_CENTER_SUMMARY_CONTRACT = "xw.command-center.summary.v1" as const;

export const COMMAND_CENTER_COMPATIBILITY_POLICY = {
  attention_command_audit_authority: "attention_command_events-append-only-overlay",
  attention_read_authority: "authoritative-attention-approval-and-pi-action-adapters-with-command-overlay",
  dual_read: "none-request-time-projection-over-current-authorities",
  dual_write: "none-legacy-facts-remain-single-writer",
  final_removal_gate: "P11.03/P11.09-and-G7-and-one-release-zero-legacy-mutation-consumers-with-backup-restore",
  handoff_read_authority: "issue_events:handoff.*.v1",
  rollback: "unregister-command-center-route-and-restore-bounded-legacy-Dashboard-reads-without-data-migration",
  run_read_authority: "issue_runs+run_attempts+issue_events-read-through-progress",
  readiness_read_authority: "issues.status+work_relations+issue_events:evidence.recorded.v1-request-time-projection",
  work_read_authority: "issues-via-Work-adapter"
} as const;

export const COMMAND_CENTER_SECTIONS = [
  "attention",
  "active_work",
  "recent_deliveries",
  "system_health"
] as const;

export type CommandCenterSectionName = typeof COMMAND_CENTER_SECTIONS[number];

export type CommandCenterFreshness = {
  is_stale: boolean;
  queried_at: string;
  source_updated_at: string;
  stale_after_seconds: number;
  state: "current" | "empty" | "stale" | "unknown";
};

export type CommandCenterSectionPayload = {
  counts: Record<string, number>;
  freshness: CommandCenterFreshness;
  operations?: Record<string, unknown>;
  recent_history?: unknown[];
  items?: unknown[];
  links: Record<string, string>;
  summary?: Record<string, unknown>;
};

export type CommandCenterSectionResult = (CommandCenterSectionPayload & { status: "ok" }) | {
  error: { code: "section_unavailable"; message: string };
  freshness: CommandCenterFreshness;
  links: Record<string, string>;
  status: "error";
};

export type CommandCenterSummary = {
  compatibility: typeof COMMAND_CENTER_COMPATIBILITY_POLICY;
  contract: typeof COMMAND_CENTER_SUMMARY_CONTRACT;
  failed_sections: CommandCenterSectionName[];
  generated_at: string;
  limits: { default: number; maximum: number; requested: number };
  partial: boolean;
  requested_sections: CommandCenterSectionName[];
  sections: Partial<Record<CommandCenterSectionName, CommandCenterSectionResult>>;
};

type SectionInput = { limit: number; now: Date };
export type CommandCenterSectionReader = (input: SectionInput) => CommandCenterSectionPayload;
export type CommandCenterSectionReaders = Record<CommandCenterSectionName, CommandCenterSectionReader>;

type CommandCenterRouteOptions = {
  now?: () => Date;
  readers?: Partial<CommandCenterSectionReaders>;
};

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 25;
const SUMMARY_TEXT_LIMIT = 320;
const ACTIVE_WORK_STATUSES: WorkStatus[] = ["todo", "in_progress", "needs_user"];
const RECENT_HANDOFF_STATUSES = ["draft", "ready", "delivered"];

export function registerCommandCenterRoutes(
  router: Router,
  context: ReadApiContext,
  options: CommandCenterRouteOptions = {}
): void {
  const readDatabase = context.readDatabase ?? context.database;
  router.get("/api/command-center/summary", (request) => commandCenterResponse(() => (
    buildCommandCenterSummary({ ...context, database: readDatabase }, request, options)
  )));
  router.get("/api/command-center/attention/:id", (request) => attentionDetailResponse(readDatabase, request));
  router.post("/api/command-center/attention/:id/actions/:action", async (request) => (
    attentionCommandResponse(context, request)
  ));
}

export function buildCommandCenterSummary(
  context: ReadApiContext,
  request: Request,
  options: CommandCenterRouteOptions = {}
): CommandCenterSummary {
  const input = requestInput(request);
  const now = options.now?.() ?? new Date();
  const defaults = commandCenterSectionReaders(context.database);
  const readers = { ...defaults, ...options.readers };
  const sections: Partial<Record<CommandCenterSectionName, CommandCenterSectionResult>> = {};
  const failedSections: CommandCenterSectionName[] = [];
  for (const section of input.sections) {
    sections[section] = readSection(section, readers[section], { limit: input.limit, now });
    if (sections[section]?.status === "error") failedSections.push(section);
  }
  return {
    compatibility: COMMAND_CENTER_COMPATIBILITY_POLICY,
    contract: COMMAND_CENTER_SUMMARY_CONTRACT,
    failed_sections: failedSections,
    generated_at: now.toISOString(),
    limits: { default: DEFAULT_LIMIT, maximum: MAX_LIMIT, requested: input.limit },
    partial: failedSections.length > 0,
    requested_sections: input.sections,
    sections
  };
}

export function commandCenterSectionReaders(db: RunnerDatabase): CommandCenterSectionReaders {
  return {
    active_work: (input) => activeWorkSection(db, input),
    attention: (input) => attentionSection(db, input),
    recent_deliveries: (input) => recentDeliveriesSection(db, input),
    system_health: (input) => systemHealthSection(db, input)
  };
}

function attentionSection(db: RunnerDatabase, input: SectionInput): CommandCenterSectionPayload {
  const projected = listPersistedAttention(db)
    .filter((item) => attentionIsVisible(item, input.now));
  const piHandling = projected.filter((item) => attentionHandling(db, item, input.now) === "pi_handling");
  const userItems = projected.filter((item) => attentionHandling(db, item, input.now) === "user_action_required");
  const historical = projected.filter((item) => attentionHandling(db, item, input.now) === "historical");
  const items = userItems.slice(0, input.limit);
  const operations = guardianOperationsSnapshot(db, { now: input.now });
  return {
    counts: {
      pi_handling: piHandling.length,
      returned: items.length,
      total: userItems.length,
      resolved_24h: operations.summary.alerts_recovered,
      source_total: userItems.length + piHandling.length,
      historical_hidden: historical.length
    },
    // This section is a request-time read of current authorities. An unchanged
    // queue is not stale data; transport/read failures are reported by the
    // section error envelope instead.
    freshness: freshness(input.now, [input.now.toISOString()], 60),
    items: items.map((item) => attentionSummary(db, item, input.now)),
    operations: {
      active: piHandling.slice(0, 5).map((item) => attentionSummary(db, item, input.now)),
      latest_report: latestGuardianOperationsReport(db),
      summary: operations.summary,
      window: operations.window
    },
    recent_history: [
      ...operations.incidents.filter((item) => item.historical === true),
      ...historical.map((item) => historicalAttentionSummary(db, item, input.now))
    ].sort((left, right) => String(right.last_seen_at).localeCompare(String(left.last_seen_at))).slice(0, 5),
    links: { collection: "/api/command-center/summary?sections=attention" }
  };
}

function attentionIsVisible(item: AttentionRecord, now: Date): boolean {
  if (item.status !== "open" && item.status !== "waiting") return false;
  if (!item.snoozed_until) return true;
  const until = Date.parse(item.snoozed_until);
  return !Number.isFinite(until) || until <= now.getTime();
}

function activeWorkSection(db: RunnerDatabase, input: SectionInput): CommandCenterSectionPayload {
  const filter = {
    limit: input.limit,
    offset: 0,
    sort: "updated_at" as const,
    sortOrder: "desc" as const,
    statuses: ACTIVE_WORK_STATUSES
  };
  const works = listIssueBackedWorks(db, filter);
  const runs = listLatestRunsForWorkIDs(db, works.map((work) => work.id));
  const runByWorkID = new Map(runs.map((run) => [run.work_id, run]));
  const sourceTimestamps = works.flatMap((work) => {
    const run = runByWorkID.get(work.id);
    return [work.updated_at, run?.updated_at ?? ""];
  });
  return {
    counts: {
      returned: works.length,
      total: countIssueBackedWorks(db, { statuses: ACTIVE_WORK_STATUSES })
    },
    freshness: freshness(input.now, sourceTimestamps, 15 * 60),
    items: works.map((work) => activeWorkSummary(db, work, runByWorkID.get(work.id))),
    links: { collection: "/api/works", runs: "/api/runs" }
  };
}

function recentDeliveriesSection(db: RunnerDatabase, input: SectionInput): CommandCenterSectionPayload {
  const filter = { statuses: RECENT_HANDOFF_STATUSES };
  const page = listStoredHandoffs(db, { ...filter, limit: input.limit });
  return {
    counts: {
      returned: page.items.length,
      skipped_invalid: page.skipped_invalid,
      total: countStoredHandoffs(db, filter)
    },
    freshness: freshness(input.now, page.items.map((record) => record.handoff.updated_at), 5 * 60),
    items: page.items.map((record) => handoffSummary(db, record)),
    links: { collection: "/api/handoffs" }
  };
}

function systemHealthSection(db: RunnerDatabase, input: SectionInput): CommandCenterSectionPayload {
  db.sqlite.query("select 1 as ok").get();
  const runCounts = countRunsByStatus(db);
  const projection = eventProjectionStatusForRead(db);
  const totalRuns = Object.values(runCounts).reduce((total, count) => total + count, 0);
  const unknownWorkStatuses = readWorkSummary(db, { includeProjects: false }).counts.unknown_status_count;
  const degraded = projection.status !== "ready" || unknownWorkStatuses > 0;
  return {
    counts: {
      ...runCounts,
      total: totalRuns
    },
    freshness: freshness(input.now, [input.now.toISOString()], 60),
    links: {
      doctor: "/api/system/doctor",
      runs: "/api/runs",
      status: "/api/system/status"
    },
    summary: {
      database: { status: "ready" },
      warnings: unknownWorkStatuses > 0 ? [{
        code: "work_status_unknown",
        count: unknownWorkStatuses,
        source: "issues.status"
      }] : [],
      event_projection: {
        lag_rows: projection.lag_rows,
        last_event_id: projection.last_event_id,
        source_last_event_id: projection.source_last_event_id,
        status: projection.status,
        updated_at: projection.updated_at
      },
      overall: degraded ? "degraded" : "healthy",
      run_progress: {
        active_runs: runCounts.running + runCounts.recovering,
        projection_mode: "read_through_rebuild",
        recovering_runs: runCounts.recovering,
        source_of_truth: "issue_runs+run_attempts+issue_events"
      }
    }
  };
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

function attentionHandling(db: RunnerDatabase, item: AttentionRecord, now: Date): string {
  return attentionDetails(db, item, now).handling as string;
}

function attentionDetails(db: RunnerDatabase, item: AttentionRecord, now: Date): Record<string, unknown> {
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

function piActionAttentionDetails(
  db: RunnerDatabase,
  action: PiAction,
  item: AttentionRecord,
  now: Date
): Record<string, unknown> {
  const target = piActionTarget(db, action);
  const notification = piActionNotificationStatus(db, action.id);
  const location = [
    action.project_id ? `项目 ${action.project_id}` : "Runner 系统",
    target.issueID > 0 ? `Issue #${target.issueID}` : "",
    action.action_type ? `动作 ${action.action_type}` : ""
  ].filter(Boolean).join(" · ");
  if (piActionIsHistorical(action, target.issueStatus)) {
    return {
      active: false,
      component: "Action Gate",
      description: `原操作目标已经进入 ${target.issueStatus || "终态"}，这条旧请求不再需要执行。`,
      diagnostic: item.summary,
      first_seen_at: item.created_at,
      handling: "historical",
      historical: true,
      last_seen_at: target.updatedAt || item.updated_at,
      location,
      pi_action: "PI 已根据当前 Issue 状态把它从用户待办中移出；原审计记录继续保留。",
      pi_can_handle: false,
      requires_user: false,
      state_label: "历史记录 · 目标已结束",
      title: "旧操作请求已失效",
      user_action: "当前无需操作。",
      source: "pi_actions"
    };
  }
  const snoozedUntil = Date.parse(action.snoozed_until);
  const piWaiting = action.status === "snoozed" && (
    (Number.isFinite(snoozedUntil) && snoozedUntil > now.getTime()) ||
    action.gate_reason === "recovery cooldown has not elapsed"
  );
  if (piWaiting) {
    return {
      active: true,
      component: "PI 恢复调度器",
      description: "恢复动作处于确定性冷却窗口，PI 会在窗口到期后重新评估。",
      diagnostic: item.summary,
      first_seen_at: item.created_at,
      handling: "pi_handling",
      historical: false,
      last_seen_at: item.updated_at,
      location,
      pi_action: "PI 正在等待恢复冷却窗口，期间不会重复启动会话或打扰你。",
      pi_can_handle: true,
      requires_user: false,
      state_label: "当前事项 · PI 等待后重试",
      title: "PI 已延后恢复动作",
      user_action: "当前无需操作。",
      source: "pi_actions"
    };
  }
  return {
    active: true,
    component: "Action Gate",
    description: notification.delivery === "sent"
      ? `PI 请求执行 ${action.action_type}，审批已经推送到飞书；页面仅保留兜底入口。`
      : notification.delivery === "failed"
        ? `PI 请求执行 ${action.action_type}，但飞书审批通知未送达；请在页面处理或修复通知目标。`
        : `PI 请求执行 ${action.action_type}，该动作需要你的明确决定。`,
    diagnostic: item.summary,
    first_seen_at: item.created_at,
    handling: "user_action_required",
    historical: false,
    last_seen_at: item.updated_at,
    location,
    notification,
    pi_action: `PI 已在 Action Gate 停止执行；原因：${action.gate_reason || "等待人工决定"}。`,
    pi_can_handle: false,
    requires_user: true,
    state_label: notification.delivery === "sent"
      ? "已推送飞书 · 页面兜底"
      : notification.delivery === "failed" ? "飞书未送达 · 页面兜底" : "当前事项 · 需要你决定",
    title: `是否允许 ${action.action_type}`,
    user_action: "审阅动作范围、目标和风险，然后批准、拒绝或要求修改。",
    source: "pi_actions"
  };
}

function piActionNotificationStatus(
  db: RunnerDatabase,
  actionID: string
): { delivery: "failed" | "missing" | "queued" | "sent"; error: string; state: string } {
  const row = db.sqlite.query<{
    error: string; outbox_error: string | null; outbox_status: string | null;
    sent_outbox_id: number; state: string;
  }, [string]>(`
    select intent.state, intent.error, intent.sent_outbox_id,
      outbox.status as outbox_status, outbox.last_error as outbox_error
    from pi_notification_intents intent
    left join sync_outbox outbox on outbox.id=intent.sent_outbox_id
    where intent.kind='pi_action_pending' and intent.source_event_id=?
    order by intent.created_at desc, intent.id desc limit 1
  `).get(actionID);
  if (!row) return { delivery: "missing", error: "notification_intent_missing", state: "missing" };
  if (row.state === "sent" && row.outbox_status === "sent") {
    return { delivery: "sent", error: "", state: row.state };
  }
  if (row.state === "failed" || row.outbox_status === "failed" || row.error !== "") {
    return { delivery: "failed", error: cleanText(row.outbox_error) || row.error, state: row.state };
  }
  return { delivery: "queued", error: "", state: row.state };
}

function piActionTarget(
  db: RunnerDatabase,
  action: PiAction
): { issueID: number; issueStatus: string; updatedAt: string } {
  const payload = safeRecord(action.payload_json);
  let issueID = positiveID(action.issue_id) || positiveID(payload.issue_id);
  if (issueID <= 0) {
    const providerSessionID = cleanText(payload.provider_session_id);
    const session = providerSessionID ? db.sqlite.query<{ issue_id: number }, [string]>(`
      select issue_id from agent_sessions where provider_session_id=? order by updated_at desc limit 1
    `).get(providerSessionID) : null;
    issueID = positiveID(session?.issue_id);
  }
  if (issueID <= 0) return { issueID: 0, issueStatus: "", updatedAt: "" };
  const issue = db.sqlite.query<{ status: string; updated_at: string }, [number]>(
    "select status, updated_at from issues where id=?"
  ).get(issueID);
  return { issueID, issueStatus: cleanText(issue?.status), updatedAt: cleanText(issue?.updated_at) };
}

function piActionIsHistorical(action: PiAction, issueStatus: string): boolean {
  if (!new Set(["done", "cancelled"]).has(issueStatus)) return false;
  return new Set([
    "issue.retry", "issue.retry_after", "issue.state_repair",
    "session.resume_followup", "session.steer"
  ]).has(action.action_type);
}

function historicalAttentionSummary(
  db: RunnerDatabase,
  item: AttentionRecord,
  now: Date
): Record<string, unknown> {
  const details = attentionDetails(db, item, now);
  return {
    alert_id: item.id,
    historical: true,
    last_seen_at: details.last_seen_at,
    location: details.location,
    state_label: details.state_label,
    title: details.title
  };
}

function safeRecord(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value || "{}") as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function positiveID(value: unknown): number {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : 0;
}

function cleanText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function attentionComponent(type: string): string {
  if (type === "approval_required") return "Action Gate";
  if (type === "input_required") return "PI 对话";
  if (type === "verification_required") return "验收门禁";
  if (type === "connection_issue") return "连接与 Provider";
  return "Work Runtime";
}

function attentionDescription(type: string): string {
  if (type === "approval_required") return "有一项可能改变外部状态或执行结果的操作，必须由你决定。";
  if (type === "input_required") return "PI 缺少继续执行所需的信息，无法安全地自行猜测。";
  if (type === "verification_required") return "工作已经产出结果，但还缺少你的验收或必要证据。";
  if (type === "connection_issue") return "连接或 Provider 不可用，PI 已停止可能产生重复副作用的操作。";
  return "当前故障或阻塞无法在自动恢复预算内解决。";
}

function attentionTitle(type: string, summary: string): string {
  if (type === "approval_required") return "需要你决定一项操作";
  if (type === "input_required") return "PI 需要你补充信息";
  if (type === "verification_required") return "结果等待你的验收";
  if (type === "connection_issue") return "连接问题需要人工处理";
  return boundedText(summary);
}

function attentionUserAction(type: string): string {
  if (type === "approval_required") return "审阅操作内容和风险，然后批准或拒绝。";
  if (type === "input_required") return "打开来源并回答 PI 提出的问题。";
  if (type === "verification_required") return "查看交付证据并确认通过，或说明需要修改的内容。";
  if (type === "connection_issue") return "检查对应连接配置；恢复后 PI 会继续执行。";
  return "打开来源查看失败事实，决定重试、修改或停止。";
}

function activeWorkSummary(db: RunnerDatabase, work: WorkLedgerEntry, run: RunView | undefined): Record<string, unknown> {
  const issueID = workIDToIssueID(work.id);
  return {
    id: work.id,
    latest_run: run ? runSummary(run) : null,
    links: {
      issue: `/api/issues/${issueID}`,
      project: `/api/projects/${encodeURIComponent(work.owner.project_id)}`,
      runs: `/api/runs?work_id=${encodeURIComponent(work.id)}`,
      self: `/api/works/${encodeURIComponent(work.id)}`
    },
    project_id: work.owner.project_id,
    readiness: readIssueReadiness(db, issueID),
    revision: work.revision,
    status: work.status,
    title: work.title,
    updated_at: work.updated_at
  };
}

function runSummary(run: RunView): Record<string, unknown> {
  return {
    ended_at: run.ended_at,
    id: run.id,
    phase: run.progress.provider_phase,
    progress: {
      latest: run.progress.latest,
      stalled: run.progress.stalled,
      updated_at: run.progress.updated_at
    },
    provider: run.provider,
    started_at: run.started_at,
    status: run.status,
    updated_at: run.updated_at
  };
}

function handoffSummary(db: RunnerDatabase, record: StoredHandoffRecord): Record<string, unknown> {
  const handoff = record.handoff;
  const issue = getIssue(db, record.issue_id);
  return {
    delivery: handoff.delivery,
    evidence_count: handoff.evidence_ids.length,
    id: handoff.id,
    issue: issue ? {
      id: issue.id,
      status: issue.status,
      title: issue.title
    } : null,
    links: {
      evidence: `/api/evidence?work_id=${encodeURIComponent(handoff.work_id)}`,
      self: `/api/handoffs/${encodeURIComponent(handoff.id)}`,
      view: handoffHref(handoff.id, handoff.work_id),
      work: `/api/works/${encodeURIComponent(handoff.work_id)}`
    },
    project_id: record.project_id,
    review: handoff.review,
    revision: handoff.revision,
    risk_count: handoff.risks.length,
    status: handoff.status,
    summary: boundedText(handoff.summary),
    updated_at: handoff.updated_at,
    work_id: handoff.work_id
  };
}

function attentionSourceLink(authority: string, localID: string): string {
  if (authority === "attention_inbox_items") return `/api/pi/attention-inbox/items/${encodeURIComponent(localID)}`;
  if (authority === "pi_guardian_alerts") return `/api/pi/guardian/alerts/${encodeURIComponent(localID)}`;
  if (authority === "pi_approval_requests") return "/api/pi/approval-requests?status=open";
  return "/api/issues";
}

function attentionDetailResponse(db: RunnerDatabase, request: Request): Response {
  const id = routeValue(request, "attention");
  const attention = getPersistedAttention(db, id);
  if (!attention) throw new HttpError(404, "Attention not found");
  return json({
    attention: attentionSummary(db, attention),
    decisions: attentionDecisionDetails(db, attention)
  });
}

async function attentionCommandResponse(context: ReadApiContext, request: Request): Promise<Response> {
  const id = routeValue(request, "attention");
  const action = routeValue(request, "actions");
  const current = getPersistedAttention(context.database, id);
  if (!current) throw new HttpError(404, "Attention not found");
  const body = await parseJsonBody(request);
  if (action !== "acknowledge" && action !== "snooze") {
    const object = objectValue(body, "Attention decision body");
    const decision = await resolveAttentionDecision(context, {
      action,
      body: object,
      relatedRefs: current.related_refs,
      sourceRefs: current.source_refs
    });
    const refreshed = getPersistedAttention(context.database, id);
    return json({ attention: refreshed ? attentionSummary(context.database, refreshed) : null, decision });
  }
  const command = attentionCommandInput(action, body);
  try {
    const result = persistAttentionCommand(context.database, id, command);
    return json({ attention: attentionSummary(context.database, result.attention), mutation: { audit_event: result.audit_event, replayed: false } });
  } catch (error) {
    throw new HttpError(409, error instanceof Error ? error.message : "Attention command failed");
  }
}

function attentionDecisionDetails(db: RunnerDatabase, attention: AttentionRecord): Array<Record<string, unknown>> {
  const details: Array<Record<string, unknown>> = [];
  for (const source of attention.source_refs) {
    if (source.authority === "pi_approval_requests") {
      const approval = getPiApprovalRequest(db, source.local_id);
      if (approval) details.push({
        kind: "provider_approval",
        ref: `approval:${approval.approval_id}`,
        request_type: approval.request_type,
        risk: approval.risk,
        status: approval.status,
        summary: approval.summary || approval.request_summary,
        provider: approval.provider,
        project_id: approval.project_id,
        run_id: approval.run_id || approval.session_id
      });
    }
    if (source.authority === "pi_actions") {
      const action = getPiAction(db, source.local_id);
      if (action) {
        const payload = safeRecord(action.payload_json);
        details.push({
        action_type: action.action_type,
        capability_id: cleanText(payload.capability_id),
        expires_at: action.lease_expires_at,
        gate_decision: action.gate_decision,
        gate_reason: action.gate_reason,
        kind: "pi_action",
        ref: `pi_action:${action.id}`,
        risk: action.risk_level,
        project_id: action.project_id,
        status: action.status,
        summary: action.rationale || action.action_type
      });
      }
    }
  }
  for (const ref of attention.related_refs.filter((value) => value.startsWith("proposal:"))) {
    const proposal = getActionProposal(db, ref.slice("proposal:".length));
    if (!proposal) continue;
    details.push({
      actions: proposal.actions.map((action) => ({
        id: action.id,
        requires_approval: action.requires_approval,
        risk: action.risk,
        status: action.execution_status || "pending",
        summary: action.summary,
        type: action.type
      })),
      kind: "proposal",
      ref,
      risk: proposal.actions.some((action) => action.risk === "high") ? "high" :
        proposal.actions.some((action) => action.risk === "medium") ? "medium" : "low",
      status: proposal.status,
      summary: proposal.summary
    });
  }
  return details;
}

function attentionCommandInput(action: "acknowledge" | "snooze", value: unknown): AttentionCommand {
  const body = objectValue(value, "Attention command body");
  const expectedRevision = body.expected_revision;
  if (typeof expectedRevision !== "number" || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
    throw new HttpError(400, "expected_revision must be a non-negative integer");
  }
  const audit = objectValue(body.audit, "audit") as AttentionTransitionAudit;
  if (!audit.actor || !audit.gate || typeof audit.event_id !== "string" || typeof audit.reason !== "string" ||
      typeof audit.correlation_id !== "string" || typeof audit.occurred_at !== "string") {
    throw new HttpError(400, "invalid Attention audit");
  }
  if (action === "snooze" && typeof body.snoozed_until !== "string") {
    throw new HttpError(400, "snoozed_until is required for snooze");
  }
  return {
    action,
    audit,
    expected_revision: expectedRevision,
    ...(action === "snooze" ? { snoozed_until: body.snoozed_until as string } : {})
  };
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, `${label} must be an object`);
  return value as Record<string, unknown>;
}

function routeValue(request: Request, before: string): string {
  const parts = new URL(request.url).pathname.split("/").filter(Boolean);
  const index = parts.indexOf(before);
  const value = index >= 0 ? parts[index + 1] : "";
  if (!value) throw new HttpError(400, `${before} route value is required`);
  return decodeURIComponent(value);
}

function readSection(
  section: CommandCenterSectionName,
  reader: CommandCenterSectionReader,
  input: SectionInput
): CommandCenterSectionResult {
  try {
    return { ...reader(input), status: "ok" };
  } catch {
    return {
      error: { code: "section_unavailable", message: `${section} query failed` },
      freshness: unknownFreshness(input.now),
      links: sectionLinks(section),
      status: "error"
    };
  }
}

function requestInput(request: Request): { limit: number; sections: CommandCenterSectionName[] } {
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

function commandCenterSection(value: string): CommandCenterSectionName {
  if (COMMAND_CENTER_SECTIONS.includes(value as CommandCenterSectionName)) return value as CommandCenterSectionName;
  throw new CommandCenterHttpError(400, "invalid_section", `unknown Command Center section: ${value}`);
}

function freshness(now: Date, timestamps: string[], staleAfterSeconds: number): CommandCenterFreshness {
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

function unknownFreshness(now: Date): CommandCenterFreshness {
  return {
    is_stale: true,
    queried_at: now.toISOString(),
    source_updated_at: "",
    stale_after_seconds: 0,
    state: "unknown"
  };
}

function sectionLinks(section: CommandCenterSectionName): Record<string, string> {
  if (section === "attention") return { collection: "/api/pi/attention-inbox/items" };
  if (section === "active_work") return { collection: "/api/works", runs: "/api/runs" };
  if (section === "recent_deliveries") return { collection: "/api/handoffs" };
  return { status: "/api/system/status" };
}

function validTimestamp(value: string): boolean {
  return value.trim() !== "" && Number.isFinite(Date.parse(value));
}

function boundedText(value: string): string {
  return value.length <= SUMMARY_TEXT_LIMIT ? value : `${value.slice(0, SUMMARY_TEXT_LIMIT - 1)}…`;
}

class CommandCenterHttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

async function commandCenterResponse(read: () => unknown | Promise<unknown>): Promise<Response> {
  try {
    return json(await read());
  } catch (error) {
    if (error instanceof CommandCenterHttpError) {
      return json({ code: error.code, message: error.message }, { status: error.status });
    }
    throw error;
  }
}
