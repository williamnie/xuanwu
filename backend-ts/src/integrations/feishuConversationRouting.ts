import type { RunnerDatabase } from "../db/database.ts";
import {
  adoptFeishuConversationState,
  bumpFeishuConversationEpoch,
  getFeishuConversationState,
  type FeishuConversationState
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
  const scope = scopeRoute(input.event);
  const command = parseFeishuNewConversationCommand(input.prompt);
  if (command.isNewCommand) {
    getFeishuConversationState(db, scope.scopeKey) ?? adoptLegacyChatRoute(db, scope, now);
    return bumpedRoute(db, scope, command.prompt, now);
  }
  const state = getFeishuConversationState(db, scope.scopeKey) ?? adoptLegacyChatRoute(db, scope, now);
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

function scopeRoute(event: FeishuNormalizedMessageEvent): ScopeRoute {
  const threadID = cleanString(event.thread_id) || cleanString(event.root_id);
  if (threadID !== "") return prefixedScope("feishu-thread", threadID);
  const chatID = cleanString(event.chat_id);
  if (chatID !== "") return chatScope(chatID);
  return prefixedScope("feishu-message", event.message_id);
}

function chatScope(chatID: string): ScopeRoute {
  const base = `feishu-chat-${sanitizeId(chatID)}`;
  return { baseConversationId: base, scopeKey: base };
}

function prefixedScope(prefix: string, rawID: string): ScopeRoute {
  const base = `${prefix}-${sanitizeId(rawID)}`;
  return { baseConversationId: base, scopeKey: base };
}

function adoptLegacyChatRoute(
  db: RunnerDatabase,
  scope: ScopeRoute,
  now: Date
): FeishuConversationState | null {
  if (!scope.baseConversationId.startsWith("feishu-chat-")) return null;
  const legacy = latestLegacyChatConversation(db, scope.baseConversationId);
  if (!legacy) return null;
  return adoptFeishuConversationState(db, {
    activeConversationId: legacy.conversationID,
    activeProjectId: legacy.state?.active_project_id,
    activeProjectSource: legacy.state?.active_project_source,
    epoch: legacy.state?.epoch ?? legacy.epoch,
    scopeKey: scope.scopeKey,
    startedAt: legacy.state?.started_at ?? legacy.createdAt
  }, now);
}

function latestLegacyChatConversation(
  db: RunnerDatabase,
  baseConversationID: string
): { conversationID: string; createdAt: string; epoch: number; state: FeishuConversationState | null } | null {
  const prefix = `${baseConversationID}-%`;
  const candidates = db.sqlite.query<{ created_at: string; id: string; updated_at: string }, [string]>(
    `select id, created_at, updated_at from pi_conversations
     where id like ? order by updated_at desc, id desc limit 64`
  ).all(prefix);
  const pattern = new RegExp(`^${escapeRegExp(baseConversationID)}-(\\d{8})(?:-n(\\d+))?$`);
  for (const candidate of candidates) {
    const match = candidate.id.match(pattern);
    if (!match) continue;
    const state = db.sqlite.query<Record<string, unknown>, [string, string]>(
      `select scope_key, active_conversation_id, active_project_id, active_project_source,
              epoch, started_at, updated_at
       from feishu_conversation_state
       where scope_key=? or active_conversation_id=?
       order by updated_at desc limit 1`
    ).get(candidate.id, candidate.id);
    return {
      conversationID: candidate.id,
      createdAt: candidate.created_at,
      epoch: Number.parseInt(match[2] ?? "0", 10) || 0,
      state: state ? legacyState(state) : null
    };
  }
  return null;
}

function legacyState(row: Record<string, unknown>): FeishuConversationState {
  return {
    active_conversation_id: cleanString(row.active_conversation_id),
    active_project_id: cleanString(row.active_project_id),
    active_project_source: cleanString(row.active_project_source),
    epoch: typeof row.epoch === "number" && Number.isInteger(row.epoch) ? row.epoch : 0,
    scope_key: cleanString(row.scope_key),
    started_at: cleanString(row.started_at),
    updated_at: cleanString(row.updated_at)
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sanitizeId(value: string): string {
  return cleanString(value).replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
