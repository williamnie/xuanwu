import type { RunnerDatabase } from "../db/database.ts";
import { cleanString, recordValue } from "./feishuShared.ts";

type FeishuSourceCandidate = {
  chat_id: string;
  chat_title: string;
  chat_type: string;
  observed_at: string;
  user_display_name: string;
  user_id: string;
};

// These are local receipt records, potentially from a previously configured app.
// Do not filter ignored messages: discovery must work before allowlist setup.
export function recentFeishuSources(database: RunnerDatabase): FeishuSourceCandidate[] {
  const rows = database.sqlite.query<{ normalized_message_json: string; received_at: string }, []>(
    `select normalized_message_json, received_at from external_events
      where source='feishu' order by id desc limit 200`
  ).all();
  const sources = new Map<string, FeishuSourceCandidate>();
  for (const row of rows) {
    try {
      const message = recordValue(JSON.parse(row.normalized_message_json));
      const sender = recordValue(message.sender);
      if (sender.kind !== "user") continue;
      const conversation = recordValue(message.conversation);
      const chatId = safeID(conversation.id || message.chat_id);
      const userId = safeID(sender.open_id) || safeID(sender.id);
      if (!chatId || !userId) continue;
      const kind = cleanString(conversation.kind || message.chat_type);
      const candidate: FeishuSourceCandidate = {
        chat_id: chatId,
        chat_title: "",
        chat_type: ["direct", "private", "p2p"].includes(kind) ? "direct" : kind === "group" ? "group" : "unknown",
        observed_at: validTime(message.occurred_at || message.timestamp) || validTime(row.received_at),
        user_display_name: "",
        user_id: userId
      };
      const key = JSON.stringify([chatId, userId]);
      const previous = sources.get(key);
      if (!previous || candidate.observed_at > previous.observed_at) sources.set(key, candidate);
    } catch {
      // Malformed historical entries are not usable source candidates.
    }
  }
  return [...sources.values()].sort((left, right) => right.observed_at.localeCompare(left.observed_at));
}

function safeID(value: unknown): string {
  const id = cleanString(value);
  return /^[A-Za-z0-9_-]{1,256}$/.test(id) ? id : "";
}

function validTime(value: unknown): string {
  const text = cleanString(value);
  const time = text ? Date.parse(text) : NaN;
  return Number.isFinite(time) ? new Date(time).toISOString() : "";
}
