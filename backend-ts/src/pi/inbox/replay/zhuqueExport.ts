import { isoTime, type SourceEventLine } from "../sourceEvent.ts";

/**
 * Converts Zhuque `source_events` rows (DingTalk plugin) into standard source events
 * for offline replay (ADR-XW-0098 TD-1 §10.1).
 *
 * Zhuque keyed direct chats by the *sender* id, so the user's own direct messages all
 * collapsed into one "chat with myself". The `channel` column is DingTalk's
 * conversation_id and is the only reliable chat key; it is used here.
 */
export type ZhuqueSourceRow = {
  external_id: string;
  channel: string | null;
  sender: string;
  text: string;
  ts: string;
  reply_to: string | null;
};

export type ZhuqueConvertOptions = {
  /** The user's DingTalk openDingtalkId values. */
  selfIds: string[];
  /** Fallback for rows without a sender id (group messages): exact display names of the user. */
  selfNames?: string[];
};

export type ZhuqueConvertResult = {
  events: SourceEventLine[];
  skipped: Array<{ external_id: string; reason: string }>;
};

type ReplyTo = { key: string; label: string; chat: string; conversationId: string; openDingtalkId: string };

export function convertZhuqueRows(rows: ZhuqueSourceRow[], options: ZhuqueConvertOptions): ZhuqueConvertResult {
  const selfIds = new Set(options.selfIds.map((id) => id.trim()).filter(Boolean));
  const selfNames = new Set((options.selfNames ?? []).map((name) => name.trim()).filter(Boolean));
  if (selfIds.size === 0 && selfNames.size === 0) throw new Error("at least one self id or self name is required");
  const parsed = rows.map((row) => ({ row, replyTo: parseReplyTo(row.reply_to) }));
  const isSelf = (row: ZhuqueSourceRow, replyTo: ReplyTo) =>
    (replyTo.chat === "direct" && selfIds.has(replyTo.openDingtalkId)) || selfNames.has(row.sender.trim());
  const peers = directPeers(parsed, isSelf);
  const events: SourceEventLine[] = [];
  const skipped: ZhuqueConvertResult["skipped"] = [];
  for (const { row, replyTo } of parsed) {
    const chatKey = (row.channel ?? "").trim() || replyTo.conversationId;
    const occurredAt = isoTime(row.ts);
    const id = row.external_id.trim();
    if (id === "") { skipped.push({ external_id: id, reason: "missing_id" }); continue; }
    if (chatKey === "") { skipped.push({ external_id: id, reason: "missing_chat_key" }); continue; }
    if (occurredAt === "") { skipped.push({ external_id: id, reason: "invalid_ts" }); continue; }
    const direct = replyTo.chat === "direct";
    const self = isSelf(row, replyTo);
    const peer = peers.get(chatKey);
    events.push({
      type: "event",
      id,
      occurred_at: occurredAt,
      chat: {
        key: chatKey,
        type: direct ? "direct" : replyTo.chat === "group" ? "group" : "other",
        label: direct ? peer?.label || "单聊" : replyTo.label
      },
      thread_key: "",
      sender: {
        key: direct && replyTo.openDingtalkId !== "" ? replyTo.openDingtalkId : `name:${row.sender.trim()}`,
        name: row.sender.trim()
      },
      is_self: self,
      text: row.text,
      truncated: false,
      reply_target: direct
        ? (peer ? { chat: "direct", openDingtalkId: peer.id } : null)
        : { chat: "group", conversationId: chatKey },
      hints: {},
      url: null
    });
  }
  events.sort((left, right) => left.occurred_at.localeCompare(right.occurred_at) || left.id.localeCompare(right.id));
  return { events, skipped };
}

/** For each direct chat, the first non-self sender is the peer: reply target and chat label. */
function directPeers(
  parsed: Array<{ row: ZhuqueSourceRow; replyTo: ReplyTo }>,
  isSelf: (row: ZhuqueSourceRow, replyTo: ReplyTo) => boolean
): Map<string, { id: string; label: string }> {
  const peers = new Map<string, { id: string; label: string }>();
  for (const { row, replyTo } of parsed) {
    const chatKey = (row.channel ?? "").trim();
    if (replyTo.chat !== "direct" || chatKey === "" || peers.has(chatKey) || isSelf(row, replyTo)) continue;
    if (replyTo.openDingtalkId === "") continue;
    peers.set(chatKey, { id: replyTo.openDingtalkId, label: replyTo.label || `${row.sender.trim()}（单聊）` });
  }
  return peers;
}

function parseReplyTo(value: string | null): ReplyTo {
  let record: Record<string, unknown> = {};
  try {
    const parsed = value ? JSON.parse(value) : {};
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) record = parsed as Record<string, unknown>;
  } catch { /* malformed reply_to: treat as empty */ }
  const field = (key: string) => typeof record[key] === "string" ? (record[key] as string).trim() : "";
  return {
    chat: field("chat"),
    conversationId: field("conversationId"),
    key: field("key"),
    label: field("label"),
    openDingtalkId: field("openDingtalkId")
  };
}
