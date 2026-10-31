import { describe, expect, test } from "bun:test";
import { isoTime, SOURCE_EVENT_TEXT_MAX, validateSourceEventLine } from "./sourceEvent.ts";

const valid = {
  type: "event",
  id: "m-1",
  occurred_at: "2026-10-30T08:00:00Z",
  chat: { key: "cid-1", type: "direct", label: "张三（单聊）" },
  sender: { key: "u-1", name: "张三" },
  is_self: false,
  text: "报告好了吗",
  reply_target: { chat: "direct", openDingtalkId: "u-1" }
};

describe("source event line", () => {
  test("normalizes a valid line", () => {
    const result = validateSourceEventLine(valid);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.event.occurred_at).toBe("2026-10-30T08:00:00.000Z");
    expect(result.event.chat).toEqual({ key: "cid-1", label: "张三（单聊）", type: "direct" });
    expect(result.event.thread_key).toBe("");
    expect(result.event.truncated).toBe(false);
  });

  test("rejects lines missing the fields Inbox depends on", () => {
    expect(validateSourceEventLine({ ...valid, id: "" })).toEqual({ ok: false, reason: "invalid_id" });
    expect(validateSourceEventLine({ ...valid, occurred_at: "yesterday" })).toEqual({ ok: false, reason: "invalid_occurred_at" });
    expect(validateSourceEventLine({ ...valid, chat: { type: "direct" } })).toEqual({ ok: false, reason: "missing_chat_key" });
    expect(validateSourceEventLine({ ...valid, sender: { name: "张三" } })).toEqual({ ok: false, reason: "missing_sender_key" });
    expect(validateSourceEventLine({ ...valid, is_self: undefined })).toEqual({ ok: false, reason: "missing_is_self" });
    expect(validateSourceEventLine({ ...valid, type: "cursor" })).toEqual({ ok: false, reason: "not_an_event_line" });
    expect(validateSourceEventLine({ ...valid, reply_target: { blob: "x".repeat(5000) } }))
      .toEqual({ ok: false, reason: "reply_target_too_large" });
  });

  test("truncates long text and defaults unknown chat types", () => {
    const result = validateSourceEventLine({ ...valid, chat: { key: "c", type: "channel" }, text: "字".repeat(SOURCE_EVENT_TEXT_MAX + 5) });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.event.chat.type).toBe("other");
    expect([...result.event.text].length).toBe(SOURCE_EVENT_TEXT_MAX);
    expect(result.event.truncated).toBe(true);
  });

  test("accepts second and millisecond epochs", () => {
    expect(isoTime(1793347200)).toBe("2026-10-30T08:00:00.000Z");
    expect(isoTime("1793347200000")).toBe("2026-10-30T08:00:00.000Z");
    expect(isoTime("")).toBe("");
  });
});
