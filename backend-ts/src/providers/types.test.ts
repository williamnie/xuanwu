import { describe, expect, test } from "bun:test";
import {
  asProviderId,
  executionRefFromSessionRef,
  isProviderId,
  sessionRefFromExecutionRef,
  type ProviderExecutionRef
} from "./types.ts";

describe("P1: ProviderId branded 校验", () => {
  test("合法 ID 通过并保持值", () => {
    for (const id of ["codex", "claude", "fake-resumable", "pi-coding-agent", "qoder", "a.b-c_1"]) {
      expect(String(asProviderId(id))).toBe(id);
      expect(isProviderId(id)).toBe(true);
    }
  });

  test("非法 ID fail closed（冒号/空/大写开头/超长）", () => {
    for (const id of ["codex:thread", "", "Codex", "x".repeat(65), "a b"]) {
      expect(() => asProviderId(id)).toThrow(/invalid provider id/);
      expect(isProviderId(id)).toBe(false);
    }
  });
});

describe("P1: ProviderExecutionRef 与 legacy SessionRef 映射", () => {
  test("full SessionRef → ProviderExecutionRef（session + message）", () => {
    const ref = executionRefFromSessionRef({ provider: "codex", sessionId: "thread-1", turnId: "turn-2" }, "codex:thread-1:turn-2");
    expect(ref).toEqual({
      providerId: asProviderId("codex"),
      invocationRef: "codex:thread-1:turn-2",
      sessionRef: "thread-1",
      messageRef: "turn-2"
    });
    expect(sessionRefFromExecutionRef(ref)).toEqual({
      provider: "codex",
      sessionId: "thread-1",
      turnId: "turn-2"
    });
  });

  test("session-only（无 message/turn）映射不产 messageRef", () => {
    const ref = executionRefFromSessionRef({ provider: "claude", sessionId: "sess-9" }, "claude:sess-9:inv-1");
    expect(ref).toEqual({
      providerId: asProviderId("claude"),
      invocationRef: "claude:sess-9:inv-1",
      sessionRef: "sess-9"
    });
    expect("messageRef" in ref).toBe(false);
  });

  test("execution-only（无 session）无 legacy 回程（sessionRefFromExecutionRef 返回 undefined）", () => {
    const ref: ProviderExecutionRef = {
      providerId: asProviderId("fake-execution-only"),
      invocationRef: "xw-inv:1"
    };
    expect(sessionRefFromExecutionRef(ref)).toBeUndefined();
  });
});
