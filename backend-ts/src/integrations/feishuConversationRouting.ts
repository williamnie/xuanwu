import type { RunnerDatabase } from "../db/database.ts";
import {
  adoptFeishuConversationState,
  type FeishuConversationState
} from "../db/repositories/feishuConversationState.ts";
import { getImConversationState } from "../db/repositories/imConversationState.ts";
import type { FeishuNormalizedMessageEvent } from "./feishu.ts";
import { feishuImInboundMessage } from "./feishuChannelConnector.ts";
import { parseImNewConversationCommand, routeImConversation } from "./imConversationRouting.ts";

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
type ScopeRoute = { baseConversationId: string; persist: boolean; scopeKey: string };

export type FeishuNewConversationCommand = { isNewCommand: boolean; prompt: string };

type LegacyConversationState = {
  active_conversation_id: string;
  epoch: number;
  scope_key: string;
  started_at: string;
  updated_at: string;
};

export function parseFeishuNewConversationCommand(prompt: string): FeishuNewConversationCommand {
  return parseImNewConversationCommand(prompt);
}

export function routeFeishuConversation(
  db: RunnerDatabase,
  input: FeishuConversationRouteInput
): FeishuConversationRoute {
  const now = input.clock?.now() ?? new Date();
  return routeImConversation(db, {
    adoptLegacy: ({ baseConversationId, now: adoptedAt, scopeKey }) => adoptLegacyChatRoute(db, {
      baseConversationId,
      persist: true,
      scopeKey
    }, adoptedAt) as ReturnType<typeof getImConversationState>,
    message: feishuImInboundMessage(input.event),
    now,
    prompt: input.prompt
  });
}

function adoptLegacyChatRoute(
  db: RunnerDatabase,
  scope: ScopeRoute,
  now: Date
): FeishuConversationState | null {
  if (!scope.baseConversationId.startsWith("feishu-chat-")) return null;
  const legacy = latestLegacyChatConversation(db, scope.baseConversationId);
  if (!legacy) return null;
  // Active project is deliberately not adopted: IM conversation state never
  // persists a current project (one-shot resolution only, design §7.1).
  return adoptFeishuConversationState(db, {
    activeConversationId: legacy.conversationID,
    epoch: legacy.state?.epoch ?? legacy.epoch,
    scopeKey: scope.scopeKey,
    startedAt: legacy.state?.started_at ?? legacy.createdAt
  }, now);
}

function latestLegacyChatConversation(
  db: RunnerDatabase,
  baseConversationID: string
): { conversationID: string; createdAt: string; epoch: number; state: LegacyConversationState | null } | null {
  const prefix = `${baseConversationID}-%`;
  const candidates = db.sqlite.query<{ created_at: string; id: string; updated_at: string }, [string]>(
    `select id, created_at, updated_at from pi_conversations
     where id like ? order by updated_at desc, id desc limit 64`
  ).all(prefix);
  const pattern = new RegExp(`^${escapeRegExp(baseConversationID)}-(\\d{8})(?:-n(\\d+))?$`);
  for (const candidate of candidates) {
    const match = candidate.id.match(pattern);
    if (!match) continue;
    // Read-only legacy lookup: pre-cutover rows may exist only in the
    // historical carrier table; they are adopted into the neutral table once.
    const state = getImConversationState(db, "feishu", candidate.id) ?? legacyCarrierState(db, candidate.id);
    return {
      conversationID: candidate.id,
      createdAt: candidate.created_at,
      epoch: Number.parseInt(match[2] ?? "0", 10) || 0,
      state
    };
  }
  return null;
}

function legacyCarrierState(db: RunnerDatabase, key: string): LegacyConversationState | null {
  const row = db.sqlite.query<Record<string, unknown>, [string, string]>(
    `select scope_key, active_conversation_id, epoch, started_at, updated_at
     from feishu_conversation_state
     where scope_key=? or active_conversation_id=?
     order by updated_at desc limit 1`
  ).get(key, key);
  if (!row) return null;
  return {
    active_conversation_id: cleanString(row.active_conversation_id),
    epoch: typeof row.epoch === "number" && Number.isInteger(row.epoch) ? row.epoch : 0,
    scope_key: cleanString(row.scope_key),
    started_at: cleanString(row.started_at),
    updated_at: cleanString(row.updated_at)
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
