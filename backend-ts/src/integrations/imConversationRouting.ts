import type { RunnerDatabase } from "../db/database.ts";
import {
  adoptImConversationState,
  bumpImConversationEpoch,
  getImConversationState,
  type ImConversationState
} from "../db/repositories/imConversationState.ts";
import type { ImInboundMessageV1 } from "./imChannelContracts.ts";

export type ImConversationRoute = {
  baseConversationId: string;
  conversationId: string;
  epoch: number;
  isNewCommand: boolean;
  prompt: string;
  scopeKey: string;
};

export type ImConversationAdopter = (input: {
  baseConversationId: string;
  now: Date;
  scopeKey: string;
}) => ImConversationState | null;

/** Provider-neutral /new + conversation/thread epoch routing. */
export function routeImConversation(db: RunnerDatabase, input: {
  adoptLegacy?: ImConversationAdopter;
  message: ImInboundMessageV1;
  now?: Date;
  prompt: string;
}): ImConversationRoute {
  const now = input.now ?? new Date();
  const scope = imScope(input.message);
  const command = parseImNewConversationCommand(input.prompt);
  if (!scope.persist) return routeView(scope, null, command);
  const current = getImConversationState(db, input.message.connector_id, scope.scopeKey) ??
    input.adoptLegacy?.({ baseConversationId: scope.baseConversationId, now, scopeKey: scope.scopeKey }) ??
    adoptImConversationState(db, {
      activeConversationId: scope.baseConversationId,
      baseConversationId: scope.baseConversationId,
      connectorId: input.message.connector_id,
      scopeKey: scope.scopeKey,
      startedAt: now.toISOString()
    }, now);
  if (!command.isNewCommand) return routeView(scope, current, command);
  const bumped = bumpImConversationEpoch(db, {
    baseConversationId: scope.baseConversationId,
    connectorId: input.message.connector_id,
    scopeKey: scope.scopeKey
  }, now);
  return routeView(scope, bumped, command);
}

export function parseImNewConversationCommand(prompt: string): { isNewCommand: boolean; prompt: string } {
  const match = cleanString(prompt).match(/^\/new(?:\s+([\s\S]*))?$/i);
  return match ? { isNewCommand: true, prompt: cleanString(match[1]) } : { isNewCommand: false, prompt: cleanString(prompt) };
}

function imScope(message: ImInboundMessageV1) {
  const connector = sanitize(message.connector_id);
  const thread = cleanString(message.thread?.id) || cleanString(message.thread?.root_message_id);
  if (thread) return scoped(`${connector}-thread`, thread, true);
  if (cleanString(message.conversation.id)) return scoped(`${connector}-chat`, message.conversation.id, true);
  return scoped(`${connector}-message`, message.message_id, false);
}

function scoped(prefix: string, id: string, persist: boolean) {
  const baseConversationId = `${prefix}-${sanitize(id)}`;
  return { baseConversationId, persist, scopeKey: baseConversationId };
}

function routeView(
  scope: ReturnType<typeof imScope>,
  state: ImConversationState | null,
  command: ReturnType<typeof parseImNewConversationCommand>
): ImConversationRoute {
  return {
    baseConversationId: scope.baseConversationId,
    conversationId: state?.active_conversation_id ?? scope.baseConversationId,
    epoch: state?.epoch ?? 0,
    isNewCommand: command.isNewCommand,
    prompt: command.prompt,
    scopeKey: scope.scopeKey
  };
}

function sanitize(value: string): string {
  return cleanString(value).replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
