import { describe, expect, test } from "bun:test";
import type { SourceEventLine } from "../sourceEvent.ts";
import { parseLabelSheet, renderLabelSheet, type SegmentLabel } from "./labelSheet.ts";
import { cutReplaySegments } from "./segments.ts";

function event(id: string, chat: string, minute: number, self = false): SourceEventLine {
  return {
    chat: { key: chat, label: `会话${chat}`, type: "direct" },
    hints: {},
    id,
    is_self: self,
    occurred_at: new Date(Date.UTC(2026, 9, 30, 2, minute)).toISOString(),
    reply_target: null,
    sender: { key: "peer", name: "张三" },
    text: `第一行 ${id}\n第二行`,
    thread_key: "",
    truncated: false,
    type: "event",
    url: null
  };
}

const segments = cutReplaySegments([event("a1", "A", 0), event("a2", "A", 1, true), event("b1", "B", 30), event("c1", "C", 60)]);

describe("label sheet", () => {
  test("renders segments with self markers and blank fields", () => {
    const sheet = renderLabelSheet(segments, { timeZone: "Asia/Shanghai" });

    expect(sheet).toContain(`<!-- segment: ${segments[0]!.id} -->`);
    expect(sheet).toContain("- [10:00] 张三：第一行 a1 ⏎ 第二行");
    expect(sheet).toContain("- [10:01] 我：第一行 a2 ⏎ 第二行");
    expect(sheet.match(/^结论：$/gm)).toHaveLength(3);
  });

  test("parses filled conclusions with aliases and reports unknown values", () => {
    const sheet = renderLabelSheet(segments).split("\n");
    let block = -1;
    const filled = sheet.map((line) => {
      if (line.startsWith("<!-- segment:")) block++;
      if (line === "结论：") return ["结论：回复", "结论：whatever", "结论："][block]!;
      if (line === "项目：" && block === 0) return "项目：movo";
      return line;
    }).join("\n");

    const parsed = parseLabelSheet(filled, segments);

    expect(parsed.labels).toEqual([
      { conclusion: "reply_draft", event_ids: ["a1"], note: "", project: "movo", segment_id: segments[0]!.id }
    ]);
    expect(parsed.errors).toEqual([{ message: "unknown conclusion: whatever", segment_id: segments[1]!.id }]);
    expect(parsed.unlabeled).toEqual([segments[2]!.id]);
  });

  test("re-renders existing labels so labelling can resume", () => {
    const existing = new Map<string, SegmentLabel>([[segments[1]!.id, {
      conclusion: "ignore", event_ids: ["b1"], note: "chitchat", project: "", segment_id: segments[1]!.id
    }]]);
    const parsed = parseLabelSheet(renderLabelSheet(segments, { existing }), segments);

    expect(parsed.labels.map((label) => [label.segment_id, label.conclusion, label.note]))
      .toEqual([[segments[1]!.id, "ignore", "chitchat"]]);
  });
});
