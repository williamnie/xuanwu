import { describe, expect, test } from "bun:test";
import { convertZhuqueRows, type ZhuqueSourceRow } from "./zhuqueExport.ts";

const SELF = "self-id";

function direct(id: string, channel: string, sender: string, senderID: string, ts: string): ZhuqueSourceRow {
  return {
    channel,
    external_id: id,
    reply_to: JSON.stringify({ chat: "direct", key: `d:${senderID}`, label: `${sender}（单聊）`, openDingtalkId: senderID }),
    sender,
    text: `${sender} says ${id}`,
    ts
  };
}

function group(id: string, channel: string, sender: string, ts: string): ZhuqueSourceRow {
  return {
    channel,
    external_id: id,
    reply_to: JSON.stringify({ chat: "group", conversationId: channel, key: `g:${channel}`, label: "项目群" }),
    sender,
    text: `${sender} in group`,
    ts
  };
}

describe("zhuque export conversion", () => {
  test("puts the user's own direct replies back into the peer's chat", () => {
    const rows = [
      direct("a1", "cid-a", "张三", "u-a", "2026-10-30T02:00:00.000Z"),
      direct("b1", "cid-b", "李四", "u-b", "2026-10-30T02:00:10.000Z"),
      // Zhuque keyed these by sender (the user) — both would collapse into d:self-id.
      direct("a2", "cid-a", "Nie 我", SELF, "2026-10-30T02:01:00.000Z"),
      direct("b2", "cid-b", "Nie 我", SELF, "2026-10-30T02:01:30.000Z")
    ];
    const { events, skipped } = convertZhuqueRows(rows, { selfIds: [SELF] });

    expect(skipped).toEqual([]);
    const byID = new Map(events.map((event) => [event.id, event]));
    expect(byID.get("a2")).toMatchObject({ chat: { key: "cid-a", label: "张三（单聊）", type: "direct" }, is_self: true });
    expect(byID.get("b2")).toMatchObject({ chat: { key: "cid-b", label: "李四（单聊）" }, is_self: true });
    expect(byID.get("a2")?.reply_target).toEqual({ chat: "direct", openDingtalkId: "u-a" });
    expect(byID.get("a1")).toMatchObject({ is_self: false, sender: { key: "u-a", name: "张三" } });
  });

  test("uses conversation ids for groups and self names as a fallback", () => {
    const rows = [
      group("g1", "cid-g", "王五", "2026-10-30T03:00:00.000Z"),
      group("g2", "cid-g", "Nie 我", "2026-10-30T03:01:00.000Z")
    ];
    const { events } = convertZhuqueRows(rows, { selfIds: [SELF], selfNames: ["Nie 我"] });

    expect(events.map((event) => [event.id, event.is_self, event.sender.key])).toEqual([
      ["g1", false, "name:王五"],
      ["g2", true, "name:Nie 我"]
    ]);
    expect(events[0]?.reply_target).toEqual({ chat: "group", conversationId: "cid-g" });
    expect(events[0]?.chat).toEqual({ key: "cid-g", label: "项目群", type: "group" });
  });

  test("leaves a self-only direct chat without a reply target and skips unusable rows", () => {
    const rows = [
      direct("s1", "cid-s", "Nie 我", SELF, "2026-10-30T04:00:00.000Z"),
      { ...direct("x1", "", "张三", "u-a", "2026-10-30T04:00:00.000Z"), reply_to: "{}" },
      direct("x2", "cid-a", "张三", "u-a", "not-a-time")
    ];
    const { events, skipped } = convertZhuqueRows(rows, { selfIds: [SELF] });

    expect(events.map((event) => event.id)).toEqual(["s1"]);
    expect(events[0]?.reply_target).toBeNull();
    expect(skipped).toEqual([
      { external_id: "x1", reason: "missing_chat_key" },
      { external_id: "x2", reason: "invalid_ts" }
    ]);
  });

  test("requires a self identity", () => {
    expect(() => convertZhuqueRows([], { selfIds: [] })).toThrow("self id");
  });
});
