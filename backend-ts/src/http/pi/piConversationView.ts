import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { RunnerDatabase } from "../../db/database.ts";
import { updatePiConversation, type PiConversation } from "../../db/repositories/pi.ts";
import { redactSensitiveText } from "../../util/redact.ts";
import type { PiRuntimeSession } from "./piRuntime.ts";
import { type PiTurnSessionEvent } from "./piSessionEvents.ts";
import { cleanString } from "../../util/values.ts";

/** Runner Chat conversation presentation: titles, live-turn runtime state and result text. */

export const PI_TURN_HEARTBEAT_MS = 15_000;

type ActivePiRun = {
  session: PiRuntimeSession["session"];
  startedAt: string;
  text: string;
  turnID: string;
  updatedAt: string;
};

export const activePiRuns = new Map<string, ActivePiRun>();

export function ensureConversationTitle(
  db: RunnerDatabase,
  conversation: PiConversation,
  prompt: string
): PiConversation {
  if (!shouldReplaceConversationTitle(conversation.title)) return conversation;
  const title = deriveConversationTitle(prompt);
  if (title === "" || title === conversation.title) return conversation;
  return updatePiConversation(db, conversation.id, { title });
}

function shouldReplaceConversationTitle(title: string): boolean {
  const text = cleanString(title);
  return text === "" || text === "Runner" || text === "New conversation" || /^Runner\s*·/.test(text);
}

function deriveConversationTitle(prompt: string): string {
  const text = cleanString(prompt)
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)]\([^)]+\)/g, "$1")
    .replace(/[*_~>#-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return truncateTitle(text);
}

function truncateTitle(text: string): string {
  const limit = 48;
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

export function piConversationRuntimeView(conversation: PiConversation) {
  const active = activePiRuns.get(conversation.id);
  return {
    ...conversation,
    active_turn_id: active?.turnID ?? "",
    last_activity_at: active?.updatedAt || conversation.updated_at,
    runtime_status: active ? "running" as const : "idle" as const,
    turn_started_at: active?.startedAt ?? ""
  };
}

export function piConversationRuntimeState(conversation: PiConversation) {
  const active = activePiRuns.get(conversation.id);
  return {
    active_text: active?.text ?? "",
    active_turn_id: active?.turnID ?? "",
    last_activity_at: active?.updatedAt || conversation.updated_at,
    runtime_status: active ? "running" as const : "idle" as const,
    turn_started_at: active?.startedAt ?? ""
  };
}

export function comparePiConversationActivity(
  left: ReturnType<typeof piConversationRuntimeView>,
  right: ReturnType<typeof piConversationRuntimeView>
): number {
  if (left.runtime_status !== right.runtime_status) return left.runtime_status === "running" ? -1 : 1;
  return right.last_activity_at.localeCompare(left.last_activity_at) || left.id.localeCompare(right.id);
}

export function recordActivePiTurnEvent(conversationID: string, event: PiTurnSessionEvent | undefined): void {
  const active = activePiRuns.get(conversationID);
  if (!active || !event) return;
  if (event.type === "assistant_text_delta") active.text += event.delta;
  active.updatedAt = new Date().toISOString();
}

export function piConversationResultText(session: AgentSession): string {
  const text = session.getLastAssistantText();
  if (text) return text;
  const error = session.state.errorMessage || lastAssistantErrorMessage(session);
  if (error === "Request was aborted") return "";
  return error ? `Runner 执行失败：${redactSensitiveText(error)}` : "";
}

export function lastAssistantErrorMessage(session: AgentSession): string {
  const messages = session.state.messages.slice().reverse();
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    const error = message.errorMessage?.trim();
    if (error) return error;
  }
  return "";
}
