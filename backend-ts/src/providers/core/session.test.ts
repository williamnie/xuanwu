import { describe, expect, test } from "bun:test";
import { asProviderId, type ProviderExecutionRef } from "../types.ts";
import { legacySessionFields } from "./legacyProjection.ts";
import { sessionDedupeKey, summaryFromDetail, SESSION_TRANSCRIPT_MAX_ITEMS, TRANSCRIPT_ITEM_PAYLOAD_MAX, type SessionDetail } from "./session.ts";
import { capTranscriptPayload, normalizeTranscriptItem, transcriptEnvelope } from "./transcript.ts";
import { CONFORMANCE_FIXTURES } from "../testing/conformanceFixtures.ts";
import type { ExecutionOnlyProvider } from "../testing/executionOnlyProvider.ts";
import type { ResumableSessionProvider } from "../testing/resumableProvider.ts";

function treeSessionTranscript(): Array<{ id: string; kind: string; role: "user" | "assistant"; text: string }> {
  // tree-session：同一 session 多分支 message（branch A / branch B）
  return [
    { id: "m-1", kind: "message", role: "user", text: "root prompt" },
    { id: "m-2", kind: "message", role: "assistant", text: "branch A reply" },
    { id: "m-3", kind: "message", role: "assistant", text: "branch B reply (fork)" }
  ];
}

describe("P3: 三类 Provider 形态通过合同", () => {
  test("fake tree-session：多分支 transcript 归一化且保留 refs", () => {
    const refs: Partial<ProviderExecutionRef> = { providerId: asProviderId("fake-resumable"), sessionRef: "tree-sess-1" };
    const items = treeSessionTranscript().map((c, i) =>
      normalizeTranscriptItem({ ...c, refs: { ...refs, messageRef: c.id } }, asProviderId("fake-resumable"), i)
    );
    expect(items).toHaveLength(3);
    expect(items.map((i) => i.id)).toEqual(["m-1", "m-2", "m-3"]);
    expect(items[2].refs?.messageRef).toBe("m-3");
    // legacy projection：thread_id 来自 sessionRef，turn_id 来自 messageRef
    expect(legacySessionFields(items[0].refs)).toEqual({ thread_id: "tree-sess-1", turn_id: "m-1" });
  });

  test("fake session-without-turn：无 messageRef 的 transcript item 可展示，turn_id 为空", () => {
    const provider: ResumableSessionProvider = CONFORMANCE_FIXTURES.resumable;
    const ref = { providerId: asProviderId(provider.id), sessionRef: "no-turn-sess" } satisfies Partial<ProviderExecutionRef>;
    const item = normalizeTranscriptItem(
      { id: "only-msg", kind: "message", text: "no turn id" },
      asProviderId(provider.id),
      0
    );
    expect(item.kind).toBe("message");
    expect(item.id).toBe("only-msg");
    expect(legacySessionFields(ref)).toEqual({ thread_id: "no-turn-sess", turn_id: "" });
  });

  test("fake execution-only：无 sessionRef 不伪造 thread_id", () => {
    const provider: ExecutionOnlyProvider = CONFORMANCE_FIXTURES.executionOnly;
    expect(provider.capabilities).toEqual(["issue_execution"]);
    expect(legacySessionFields(undefined)).toEqual({ thread_id: "", turn_id: "" });
  });
});

describe("P3: transcript normalization（unknown preserve）", () => {
  test("unknown item 可展示且不改变状态（kind=unknown，payload 保留）", () => {
    const item = normalizeTranscriptItem(
      { kind: "mystery-event", payload: { raw: "something new" } },
      asProviderId("codex"),
      0
    );
    expect(item.kind).toBe("unknown");
    expect(item.payload).toEqual({ raw: "something new" });
    expect(item.providerNative?.type).toBe("mystery-event");
  });

  test("无 id 的 item 获得稳定本地 id，不抛错", () => {
    const item = normalizeTranscriptItem({ kind: "message", text: "hi" }, asProviderId("claude"), 5);
    expect(item.id).toBe("claude:item:5");
  });
});

describe("P3: 有界性（列表不加载完整 transcript）", () => {
  test("summaryFromDetail 剥离 transcript/cursor/native", () => {
    const detail: SessionDetail = {
      id: "p:s",
      providerId: asProviderId("codex"),
      sessionRef: "s",
      title: "t",
      preview: "p",
      status: "active",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      thread_id: "s",
      turn_id: "",
      providerSessionId: "s",
      transcript: [{ id: "1", kind: "message" }],
      cursor: "next-cursor",
      native: { version: 1, size: 10, truncated: false }
    };
    const summary = summaryFromDetail(detail);
    expect("transcript" in summary).toBe(false);
    expect("cursor" in summary).toBe(false);
    expect("native" in summary).toBe(false);
    expect(summary.sessionRef).toBe("s");
  });

  test("transcript envelope 超 item 数 bound → truncated 标记且裁剪", () => {
    const items = Array.from({ length: SESSION_TRANSCRIPT_MAX_ITEMS + 50 }, (_, i) =>
      normalizeTranscriptItem({ kind: "message", text: `m${i}` }, asProviderId("codex"), i)
    );
    const envelope = transcriptEnvelope(items, 1, "2026-01-01T00:00:00Z");
    expect(envelope.truncated).toBe(true);
    expect(envelope.items.length).toBe(SESSION_TRANSCRIPT_MAX_ITEMS);
    expect(envelope.provenance.revision).toBe(1);
  });

  test("dedupe key 固定为 <providerId>:<sessionRef>", () => {
    expect(sessionDedupeKey(asProviderId("codex"), "thread-1")).toBe("codex:thread-1");
    expect(sessionDedupeKey(asProviderId("fake-resumable"), "sess-2")).toBe("fake-resumable:sess-2");
  });
});

describe("P3: native payload 超限裁剪并留 provenance", () => {
  test("超限 payload 被裁剪为 truncated 标记", () => {
    const big = "x".repeat(TRANSCRIPT_ITEM_PAYLOAD_MAX + 1000);
    const item = normalizeTranscriptItem({ kind: "message", payload: big }, asProviderId("codex"), 0);
    expect(item.payload).toEqual({ truncated: true, note: "payload exceeded bound and was clipped" });
    expect(item.providerNative?.size).toBeLessThanOrEqual(TRANSCRIPT_ITEM_PAYLOAD_MAX);
  });

  test("capTranscriptPayload 保留 provenance 的 truncated 标记", () => {
    const small = capTranscriptPayload({ a: 1 });
    expect(small).toEqual({ value: { a: 1 }, truncated: false });
    const large = capTranscriptPayload("y".repeat(TRANSCRIPT_ITEM_PAYLOAD_MAX + 1));
    expect(large.truncated).toBe(true);
    expect(large.value).toMatchObject({ truncated: true });
  });
});
