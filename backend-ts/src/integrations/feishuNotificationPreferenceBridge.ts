import type { RunnerDatabase } from "../db/database.ts";
import {
  PiNotificationPreferenceValidationError,
  writePiNotificationPreference
} from "../pi/notificationPreferenceService.ts";
import { redactSensitiveText } from "../util/redact.ts";
import type { FeishuNormalizedMessageEvent } from "./feishu.ts";
import type { FeishuIngestResult } from "./feishuIngest.ts";

export type FeishuNotificationPreferenceInput = {
  conversationId: string;
  event: FeishuNormalizedMessageEvent;
  ingest: FeishuIngestResult;
  now?: Date;
  projectId: string;
  text: string;
};
export type FeishuNotificationPreferenceResult = {
  handled: boolean;
  reason: string;
  text: string;
};

const COMMANDS = ["/notify", "/notification", "/preference", "通知偏好"] as const;

export function applyFeishuNotificationPreferenceCommand(
  db: RunnerDatabase,
  input: FeishuNotificationPreferenceInput
): FeishuNotificationPreferenceResult {
  const raw = commandBody(input.text);
  if (raw === null) return result(false, "", "");
  try {
    const candidate = candidateFromCommand(raw, input);
    const saved = writePiNotificationPreference(db, candidate);
    return result(true, "notification_preference_saved", saved.confirmation_text);
  } catch (error) {
    return result(true, errorReason(error), rejectedText(error));
  }
}

function candidateFromCommand(body: string, input: FeishuNotificationPreferenceInput): Record<string, unknown> {
  const candidate = parseCandidateBody(body);
  return {
    ...candidate,
    conversation_id: cleanString(candidate.conversation_id) || input.conversationId,
    now: input.now?.toISOString(),
    project_id: cleanString(candidate.project_id) || input.projectId,
    scope: cleanString(candidate.scope) || "conversation",
    source_event_id: input.ingest.event_id > 0 ? `external_event:${input.ingest.event_id}` : "",
    source_event_sequence_id: input.ingest.event_id,
    source_message_id: input.event.message_id
  };
}

function parseCandidateBody(body: string): Record<string, unknown> {
  const text = body.trim();
  if (text === "") throw new PiNotificationPreferenceValidationError("preference candidate json is required");
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new PiNotificationPreferenceValidationError("preference candidate must be an object");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof PiNotificationPreferenceValidationError) throw error;
    throw new PiNotificationPreferenceValidationError("preference candidate must be valid JSON");
  }
}

function commandBody(text: string): string | null {
  const clean = text.trim();
  for (const command of COMMANDS) {
    if (clean === command) return "";
    if (clean.startsWith(`${command} `)) return clean.slice(command.length).trim();
  }
  return null;
}

function errorReason(error: unknown): string {
  return error instanceof PiNotificationPreferenceValidationError
    ? "notification_preference_rejected"
    : "notification_preference_failed";
}

function rejectedText(error: unknown): string {
  return `通知偏好没有保存：${safeError(error)}。请发送 /notify 后跟结构化 JSON，例如 {"mode":"quiet","temporary":true,"ttl_minutes":480}。`;
}

function safeError(error: unknown): string {
  return redactSensitiveText(error instanceof Error ? error.message : String(error));
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function result(handled: boolean, reason: string, text: string): FeishuNotificationPreferenceResult {
  return { handled, reason, text };
}
