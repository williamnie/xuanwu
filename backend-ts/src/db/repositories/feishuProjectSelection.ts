import type { RunnerDatabase } from "../database.ts";
import {
  consumeImProjectSelection,
  createImProjectSelection,
  getImProjectSelection,
  type ImProjectSelection
} from "./imProjectSelections.ts";

/**
 * W1 compatibility shim over the provider-neutral `im_project_selections`
 * repository (design 2026-08-02-generic-im-channel-telegram-design.md §13.2).
 * The generic table is the single application writer; this module only keeps
 * the legacy Feishu call-sites and read shape working during the bounded
 * compatibility window. The physical `feishu_project_selections` table stays
 * as a read-only historical carrier (backfilled by 071/071a) until a separate
 * destructive migration removes it.
 */
export const FEISHU_IM_CONNECTOR_ID = "feishu";

export type FeishuProjectSelectionStatus = "pending" | "consumed";
export type FeishuPendingProjectSelection = {
  candidates: string[];
  candidates_json: string;
  chat_id: string;
  consumed_at: string;
  conversation_id: string;
  created_at: string;
  expires_at: string;
  original_prompt: string;
  scope_key: string;
  selected_project_id: string;
  selection_id: string;
  source_message_id: string;
  status: FeishuProjectSelectionStatus;
  user_id: string;
  user_open_id: string;
};
export type FeishuPendingProjectSelectionInput = {
  candidates: string[];
  chatId: string;
  conversationId: string;
  expiresAt: string;
  originalPrompt: string;
  scopeKey: string;
  selectionId: string;
  sourceMessageId: string;
  userId: string;
  userOpenId: string;
};
export type FeishuProjectSelectionConsumeInput = {
  chatId: string;
  now: Date;
  projectId: string;
  selectionId: string;
  userId: string;
  userOpenId: string;
};
export type FeishuProjectSelectionConsumeResult = {
  selection: FeishuPendingProjectSelection | null;
  status: "already_consumed" | "consumed" | "expired" | "invalid_project" | "missing" | "source_mismatch";
};

export function createFeishuPendingProjectSelection(
  db: RunnerDatabase,
  input: FeishuPendingProjectSelectionInput,
  timestamp = new Date()
): FeishuPendingProjectSelection {
  return legacyView(createImProjectSelection(db, {
    candidates: input.candidates,
    chatId: input.chatId,
    connectorId: FEISHU_IM_CONNECTOR_ID,
    conversationId: input.conversationId,
    expiresAt: input.expiresAt,
    originalPrompt: input.originalPrompt,
    scopeKey: input.scopeKey,
    selectionId: input.selectionId,
    sourceMessageId: input.sourceMessageId,
    userId: input.userId,
    userOpenId: input.userOpenId
  }, timestamp));
}

export function getFeishuPendingProjectSelection(
  db: RunnerDatabase,
  selectionId: string
): FeishuPendingProjectSelection | null {
  const selection = getImProjectSelection(db, selectionId);
  return selection ? legacyView(selection) : null;
}

export function consumeFeishuPendingProjectSelection(
  db: RunnerDatabase,
  input: FeishuProjectSelectionConsumeInput
): FeishuProjectSelectionConsumeResult {
  const consumed = consumeImProjectSelection(db, {
    chatId: input.chatId,
    connectorId: FEISHU_IM_CONNECTOR_ID,
    now: input.now,
    projectId: input.projectId,
    selectionId: input.selectionId,
    userId: input.userId,
    userOpenId: input.userOpenId
  });
  return {
    selection: consumed.selection ? legacyView(consumed.selection) : null,
    status: consumed.status
  };
}

function legacyView(selection: ImProjectSelection): FeishuPendingProjectSelection {
  return {
    candidates: selection.candidates,
    candidates_json: selection.candidates_json,
    chat_id: selection.chat_id,
    consumed_at: selection.consumed_at,
    conversation_id: selection.conversation_id,
    created_at: selection.created_at,
    expires_at: selection.expires_at,
    original_prompt: selection.original_prompt,
    scope_key: selection.scope_key,
    selected_project_id: selection.selected_project_id,
    selection_id: selection.selection_id,
    source_message_id: selection.source_message_id,
    status: selection.status,
    user_id: selection.user_id,
    user_open_id: selection.user_open_id
  };
}
