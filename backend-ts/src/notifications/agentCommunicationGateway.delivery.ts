import type { RunnerDatabase } from "../db/database.ts";
import { createPiActionEvent, type PiNotificationIntent } from "../db/repositories/pi.ts";
import { queueNotificationOutbox } from "./notificationOutbox.ts";
import { agentCommunicationIncident } from "./agentCommunicationIncidents.ts";
import { applyNotificationSpeaker, containsQuestionLikeLanguage, notificationPresentation, type NotificationPresentation } from "./notificationPresentation.ts";
import { communicationEnvelope, singleIssueID, groupDigest, hasTarget, fallbackIdentity, safeError } from "./agentCommunicationGateway.intent.ts";
import type { AgentCommunicationFailure, AgentCommunicationDecision } from "./agentCommunicationGateway.model.ts";

export function isExplicitSubscriptionDelivery(intent: PiNotificationIntent): boolean {
  return intent.kind === "automation_watch_terminal" || intent.kind === "issue_completion_watch_satisfied";
}

export function explicitSubscriptionMessage(
  intents: PiNotificationIntent[],
  presentation: NotificationPresentation
): string {
  const messages = [...new Set(intents
    .filter(isExplicitSubscriptionDelivery)
    .map((intent) => communicationEnvelope(intent).contentSeed)
    .filter(Boolean))];
  const fallback = presentation.language === "zh-CN"
    ? `${presentation.display_name}：你订阅的观察已结束，结果已经整理好。`
    : `${presentation.display_name}: The watch you subscribed to has ended and the result is ready.`;
  return applyNotificationSpeaker(messages.join("\n\n") || fallback, presentation);
}

export function queueAgentMessage(db: RunnerDatabase, intents: PiNotificationIntent[], content: string) {
  const first = intents[0]!;
  const envelope = communicationEnvelope(first);
  return queueNotificationOutbox(db, {
    approvalActionID: envelope.approvalActionID,
    channel: envelope.channel,
    content,
    createdBy: "notification_agent",
    issueID: singleIssueID(intents),
    notificationID: `agent:${groupDigest(intents)}`,
    notificationType: "agent_communication",
    projectID: first.project_id,
    target: envelope.target
  });
}

export function queueAgentFailureFallback(
  db: RunnerDatabase,
  intents: PiNotificationIntent[],
  now: Date,
  failureCode: AgentCommunicationFailure["code"]
): boolean {
  const first = intents[0];
  if (!first) return false;
  const presentation = notificationPresentation(db);
  const envelope = communicationEnvelope(first);
  if (!hasTarget(envelope)) return false;
  const issue = singleIssueID(intents);
  const subject = issue > 0 ? `issue #${issue}` : "这批事项";
  const content = fallbackMessage(presentation, failureCode, subject);
  return db.transaction(() => {
    const incident = agentCommunicationIncident(db, {
      identity: fallbackIdentity(first), projectID: first.project_id, failureCode, now
    });
    if (incident.status !== "open") return false;
    return queueNotificationOutbox(db, {
      channel: envelope.channel,
      content,
      createdBy: "notification_agent_fallback",
      issueID: issue,
      notificationID: `agent-communication-fallback:${incident.id}`,
      notificationType: "agent_communication_fallback",
      projectID: first.project_id,
      target: envelope.target
    }).queued;
  }).immediate();
}

export function mayAskUser(intents: PiNotificationIntent[]): boolean {
  return intents.some((intent) => intent.requires_user === 1 ||
    intent.kind === "pi_action_pending" || /approval/i.test(intent.kind));
}

export function recordNonActionableQuestionObservation(
  db: RunnerDatabase,
  intents: PiNotificationIntent[],
  decision: AgentCommunicationDecision
): void {
  if (decision.decision !== "send" || mayAskUser(intents) || !containsQuestionLikeLanguage(decision.message)) return;
  const first = intents[0];
  if (!first) return;
  try {
    createPiActionEvent(db, {
      action_id: `notification-presentation:${groupDigest(intents)}`,
      actor: "notification_agent",
      conversation_id: first.conversation_id,
      decision: "observe",
      event_type: "notification.presentation.non_actionable_question",
      issue_id: singleIssueID(intents),
      payload_json: JSON.stringify({
        intent_ids: intents.map((intent) => intent.id),
        kinds: [...new Set(intents.map((intent) => intent.kind))]
      }),
      project_id: first.project_id,
      reason: "non-actionable notification used question-like language"
    });
  } catch (error) {
    console.warn("[notification-presentation] failed to record question observation:", safeError(error));
  }
}

export function fallbackMessage(
  presentation: NotificationPresentation,
  failureCode: AgentCommunicationFailure["code"],
  subject: string
): string {
  if (presentation.language === "en-US") {
    return failureCode === "agent_output_invalid"
      ? `${presentation.display_name} responded, but the automatic notification format was invalid, so I paused this batch to avoid noise. Normal chat is unaffected.`
      : `${presentation.display_name} is temporarily unavailable, so I paused automatic notifications for ${subject}. Check the Agent/provider runtime; notifications will resume after recovery.`;
  }
  return failureCode === "agent_output_invalid"
    ? `${presentation.display_name} 已响应，但自动通知格式不兼容。我已暂停这批通知，避免继续刷屏；普通聊天不受影响。`
    : `${presentation.display_name} 暂时不可用，我已暂停 ${subject} 的自动通知。请检查 Agent/provider 运行状态；恢复后会继续处理后续消息。`;
}

export function classifyAgentCommunicationFailure(error: unknown): AgentCommunicationFailure {
  const message = safeError(error);
  return {
    code: /invalid communication|suppressed an actionable communication|empty user message/i.test(message)
      ? "agent_output_invalid"
      : "agent_unavailable",
    message
  };
}
