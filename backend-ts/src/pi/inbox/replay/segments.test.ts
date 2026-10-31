import { describe, expect, test } from "bun:test";
import type { SourceEventLine } from "../sourceEvent.ts";
import { cutReplaySegments } from "./segments.ts";

function event(id: string, chat: string, minute: number, self = false): SourceEventLine {
  return {
    chat: { key: chat, label: `chat ${chat}`, type: "direct" },
    hints: {},
    id,
    is_self: self,
    occurred_at: new Date(Date.UTC(2026, 9, 30, 2, minute)).toISOString(),
    reply_target: null,
    sender: { key: self ? "me" : "peer", name: self ? "我" : "对方" },
    text: id,
    thread_key: "",
    truncated: false,
    type: "event",
    url: null
  };
}

describe("replay segments", () => {
  test("keeps a back-and-forth in one segment and labels only other people's messages", () => {
    const segments = cutReplaySegments([
      event("a1", "A", 0),
      event("a2", "A", 2, true),
      event("a3", "A", 5),
      event("b1", "B", 1)
    ]);

    const chatA = segments.filter((segment) => segment.chat_key === "A");
    expect(chatA).toHaveLength(1);
    expect(chatA[0]?.messages.map((message) => message.id)).toEqual(["a1", "a2", "a3"]);
    expect(chatA[0]?.event_ids).toEqual(["a1", "a3"]);
    expect(segments.map((segment) => segment.chat_key)).toEqual(["A", "B"]);
  });

  test("splits on silence, skips self-only stretches, and carries earlier context", () => {
    const segments = cutReplaySegments([
      event("a1", "A", 0),
      event("a2", "A", 30, true),
      event("a3", "A", 50),
      event("a4", "A", 52)
    ], { contextSize: 2, gapMinutes: 10 });

    expect(segments.map((segment) => segment.event_ids)).toEqual([["a1"], ["a3", "a4"]]);
    expect(segments[1]?.context_before.map((message) => message.id)).toEqual(["a1", "a2"]);
    expect(segments[0]?.id).toMatch(/^[a-f0-9]{6}-1$/);
    expect(segments[1]?.id).toMatch(/^[a-f0-9]{6}-2$/);
  });
});
