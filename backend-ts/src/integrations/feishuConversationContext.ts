import type { RunnerDatabase } from "../db/database.ts";
import { buildImConversationPromptContext } from "./imConversationContext.ts";
import { FEISHU_CONNECTOR_ID } from "./feishuChannelConnector.ts";
import type { FeishuNormalizedMessageEvent } from "./feishu.ts";

/**
 * Feishu adapter shim over the provider-neutral context projector. The generic
 * projector owns the SQL and bounding rules; this module only maps the Feishu
 * normalized event into an opaque conversation/thread scope.
 */
export function buildFeishuConversationPromptContext(
  db: RunnerDatabase,
  input: { event: FeishuNormalizedMessageEvent; limit?: number }
): string {
  return buildImConversationPromptContext(db, {
    conversation: {
      connectorId: FEISHU_CONNECTOR_ID,
      conversationId: input.event.chat_id,
      currentMessageId: input.event.message_id,
      threadId: cleanString(input.event.thread_id) || cleanString(input.event.root_id)
    },
    limit: input.limit
  });
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
