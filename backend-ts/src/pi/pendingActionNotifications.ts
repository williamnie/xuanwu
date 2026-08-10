import type { RunnerDatabase } from "../db/database.ts";
import {
  createPiNotificationIntent,
  listPiActions,
  listPiNotificationIntents
} from "../db/repositories/pi.ts";
import {
  resolveImNotificationConnectorID,
  resolveImNotificationTarget
} from "../integrations/imNotificationTargets.ts";
import { routeNotification } from "../notifications/unifiedNotificationPipeline.ts";
import { redactSensitiveText } from "../util/redact.ts";
import { SUPERVISOR_NOTIFICATION_PREFIX } from "../xuanwu/userFacingTerminology.ts";

const ACTION_TYPES = new Set(["assistant.tool.call", "mcp.tool.call"]);

export function queuePendingImActionNotifications(
  db: RunnerDatabase,
  options: { lookbackMs?: number; maxPerSweep?: number; now?: Date } = {}
): { failed: number; queued: number; scanned: number; skipped: number } {
  const intents = new Map(listPiNotificationIntents(db, { kind: "pi_action_pending" })
    .map((intent) => [intent.source_event_id, intent]));
  const summary = { failed: 0, queued: 0, scanned: 0, skipped: 0 };
  const cutoff = (options.now ?? new Date()).getTime() - (options.lookbackMs ?? 10 * 60_000);
  const limit = Math.max(1, Math.min(20, Math.trunc(options.maxPerSweep ?? 5)));
  for (const action of listPiActions(db, { status: "pending" })) {
    summary.scanned += 1;
    if (!ACTION_TYPES.has(action.action_type) || !recent(action.created_at, cutoff)) {
      summary.skipped += 1;
      continue;
    }
    const existing = intents.get(action.id);
    if ((existing && existing.state !== "failed") || summary.queued >= limit) {
      summary.skipped += 1;
      continue;
    }
    const connectorID = resolveImNotificationConnectorID(db, {
      conversationID: action.conversation_id,
      issueID: action.issue_id,
      projectID: action.project_id
    });
    const target = connectorID === "" ? null : resolveImNotificationTarget(db, {
      connectorID,
      conversationID: action.conversation_id,
      issueID: action.issue_id,
      projectID: action.project_id
    });
    if (!target) {
      recordUnroutable(db, action, connectorID);
      summary.failed += 1;
      continue;
    }
    const result = routeNotification(db, {
      approvalActionID: `pi_action:${action.id}`,
      content: pendingActionText(action),
      conversationID: target.thread_id || target.conversation_id,
      idempotencyKey: `pi_action_pending:${action.id}`,
      issueID: action.issue_id,
      kind: "pi_action_pending",
      notificationID: action.id,
      notificationType: "pi_action_pending_notification",
      payload: { action_id: action.id, action_type: action.action_type, issue_id: action.issue_id },
      projectID: action.project_id,
      requiresUser: true,
      routes: [{
        channel: target.connector_id,
        chatID: target.conversation_id,
        eventID: target.external_event_id,
        messageID: target.reply_to_message_id,
        threadID: target.thread_id
      }],
      severity: "actionable",
      sourceEventID: action.id,
      sourceEventType: "pi.action_pending",
      summary: `PI action ${action.id} pending approval`
    })[0];
    if (result?.queued) summary.queued += 1;
    else summary.skipped += 1;
  }
  return summary;
}

function recordUnroutable(
  db: RunnerDatabase,
  action: ReturnType<typeof listPiActions>[number],
  connectorID: string
): void {
  createPiNotificationIntent(db, {
    conversation_id: action.conversation_id,
    decision: "send_now",
    error: connectorID === "" ? "missing_im_connector" : "missing_im_target",
    idempotency_key: `pi_action_pending:${action.id}:${connectorID || "unrouted"}`,
    issue_id: action.issue_id,
    kind: "pi_action_pending",
    payload_json: { action_id: action.id, action_type: action.action_type, issue_id: action.issue_id },
    project_id: action.project_id,
    requires_user: 1,
    severity: "actionable",
    source_event_id: action.id,
    source_event_type: "pi.action_pending",
    state: "failed",
    summary: `PI action ${action.id} pending approval; IM target missing`,
    target_channel: connectorID
  });
}

function pendingActionText(action: ReturnType<typeof listPiActions>[number]): string {
  const payload = object(action.payload_json);
  const detail = redactSensitiveText(JSON.stringify({
    capability: text(payload.capability_id),
    permission: text(payload.permission),
    provider: text(payload.provider_id),
    tool: text(payload.tool_name)
  })).slice(0, 360);
  return [
    `${SUPERVISOR_NOTIFICATION_PREFIX}：${action.issue_id > 0 ? `issue #${action.issue_id}` : "当前任务"} 需要用户确认才能继续。`,
    `待确认动作：${action.action_type}（${action.id}）`,
    detail === "{}" ? "" : `范围：${detail}`,
    "下一步：可在当前 IM 交互中批准、拒绝、要求修改或暂缓；Runner issue/后端 API 仍作为备用入口。"
  ].filter(Boolean).join("\n");
}

function recent(value: string, cutoff: number): boolean {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp >= cutoff;
}

function object(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch { return {}; }
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
