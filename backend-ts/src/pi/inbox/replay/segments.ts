import { createHash } from "node:crypto";
import type { SourceEventLine } from "../sourceEvent.ts";

/**
 * Cuts replay events into labelling segments (ADR-XW-0098 TD-1 §10.2):
 * per chat, a segment starts at a non-self message and continues while the next
 * message (from anyone) follows within `gapMinutes`. Self-only stretches are not
 * segments; they appear as context. Only non-self messages need a label.
 */
export type ReplaySegment = {
  id: string;
  chat_key: string;
  chat_label: string;
  chat_type: SourceEventLine["chat"]["type"];
  started_at: string;
  /** Non-self messages the label applies to. */
  event_ids: string[];
  /** All messages in the segment, self included, in time order. */
  messages: SourceEventLine[];
  /** Up to `contextSize` earlier messages of the same chat. */
  context_before: SourceEventLine[];
};

export type SegmentOptions = { gapMinutes?: number; contextSize?: number };

export function cutReplaySegments(events: SourceEventLine[], options: SegmentOptions = {}): ReplaySegment[] {
  const gapMs = (options.gapMinutes ?? 10) * 60_000;
  const contextSize = options.contextSize ?? 5;
  const byChat = new Map<string, SourceEventLine[]>();
  for (const event of events) byChat.set(event.chat.key, [...(byChat.get(event.chat.key) ?? []), event]);
  const segments: ReplaySegment[] = [];
  for (const [chatKey, chatEvents] of byChat) {
    const ordered = [...chatEvents].sort((a, b) => a.occurred_at.localeCompare(b.occurred_at) || a.id.localeCompare(b.id));
    let index = 0;
    let count = 0;
    while (index < ordered.length) {
      if (ordered[index]!.is_self) { index++; continue; }
      const start = index;
      let end = index;
      while (end + 1 < ordered.length && ms(ordered[end + 1]!) - ms(ordered[end]!) <= gapMs) end++;
      const messages = ordered.slice(start, end + 1);
      const first = messages[0]!;
      count++;
      segments.push({
        id: `${shortHash(chatKey)}-${count}`,
        chat_key: chatKey,
        chat_label: first.chat.label,
        chat_type: first.chat.type,
        started_at: first.occurred_at,
        event_ids: messages.filter((message) => !message.is_self).map((message) => message.id),
        messages,
        context_before: ordered.slice(Math.max(0, start - contextSize), start)
      });
      index = end + 1;
    }
  }
  return segments.sort((a, b) => a.started_at.localeCompare(b.started_at) || a.id.localeCompare(b.id));
}

function ms(event: SourceEventLine): number {
  return Date.parse(event.occurred_at);
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 6);
}
