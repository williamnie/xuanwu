import type { RunnerDatabase } from "../db/database.ts";
import {
  bumpFeishuConversationEpoch,
  getFeishuConversationState
} from "../db/repositories/feishuConversationState.ts";
import type { FeishuNormalizedMessageEvent } from "./feishu.ts";

export type FeishuConversationClock = { now(): Date };
export type FeishuConversationRouteInput = {
  clock?: FeishuConversationClock;
  event: FeishuNormalizedMessageEvent;
  prompt: string;
};
export type FeishuConversationRoute = {
  baseConversationId: string;
  conversationId: string;
  epoch: number;
  isNewCommand: boolean;
  prompt: string;
  scopeKey: string;
};
export type FeishuNewConversationCommand = { isNewCommand: boolean; prompt: string };
type ScopeRoute = { baseConversationId: string; scopeKey: string };

export function parseFeishuNewConversationCommand(prompt: string): FeishuNewConversationCommand {
  const match = cleanString(prompt).match(/^\/new(?:\s+([\s\S]*))?$/i);
  return match
    ? { isNewCommand: true, prompt: cleanString(match[1]) }
    : { isNewCommand: false, prompt: cleanString(prompt) };
}

export function routeFeishuConversation(
  db: RunnerDatabase,
  input: FeishuConversationRouteInput
): FeishuConversationRoute {
  const now = input.clock?.now() ?? new Date();
  const scope = scopeRoute(input.event, now);
  const command = parseFeishuNewConversationCommand(input.prompt);
  if (command.isNewCommand) return bumpedRoute(db, scope, command.prompt, now);
  const state = getFeishuConversationState(db, scope.scopeKey);
  return {
    baseConversationId: scope.baseConversationId,
    conversationId: state?.active_conversation_id ?? scope.baseConversationId,
    epoch: state?.epoch ?? 0,
    isNewCommand: false,
    prompt: cleanString(input.prompt),
    scopeKey: scope.scopeKey
  };
}

function bumpedRoute(
  db: RunnerDatabase,
  scope: ScopeRoute,
  prompt: string,
  now: Date
): FeishuConversationRoute {
  const state = bumpFeishuConversationEpoch(db, {
    baseConversationId: scope.baseConversationId,
    scopeKey: scope.scopeKey
  }, now);
  return {
    baseConversationId: scope.baseConversationId,
    conversationId: state.active_conversation_id,
    epoch: state.epoch,
    isNewCommand: true,
    prompt,
    scopeKey: scope.scopeKey
  };
}

function scopeRoute(event: FeishuNormalizedMessageEvent, now: Date): ScopeRoute {
  const threadID = cleanString(event.thread_id) || cleanString(event.root_id);
  if (threadID !== "") return prefixedScope("feishu-thread", threadID);
  const chatID = cleanString(event.chat_id);
  if (chatID !== "") return chatScope(chatID, now);
  return prefixedScope("feishu-message", event.message_id);
}

function chatScope(chatID: string, now: Date): ScopeRoute {
  const base = `feishu-chat-${sanitizeId(chatID)}-${dayKey(now)}`;
  return { baseConversationId: base, scopeKey: base };
}

function prefixedScope(prefix: string, rawID: string): ScopeRoute {
  const base = `${prefix}-${sanitizeId(rawID)}`;
  return { baseConversationId: base, scopeKey: base };
}

function dayKey(value: Date): string {
  return `${value.getFullYear()}${pad(value.getMonth() + 1)}${pad(value.getDate())}`;
}

function sanitizeId(value: string): string {
  return cleanString(value).replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
