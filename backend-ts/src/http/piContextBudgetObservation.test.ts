import { describe, expect, test } from "bun:test";
import {
  buildPiCompactionObservation,
  installPiContextBudgetObservation,
  piRuntimeSurface
} from "./piContextBudgetObservation.ts";

describe("PI context budget observe-only audit", () => {
  test("classifies Feishu, Telegram, Runner Chat, and internal profiles without changing routing", () => {
    expect(piRuntimeSurface({
      conversationID: "feishu-chat-one",
      promptProfile: "chat",
      source: "feishu_runner_chat"
    })).toBe("feishu");
    expect(piRuntimeSurface({
      conversationID: "telegram-chat-one",
      promptProfile: "chat",
      source: "runner_chat"
    })).toBe("telegram");
    expect(piRuntimeSurface({
      conversationID: "runner-chat-one",
      promptProfile: "chat",
      source: "runner_chat"
    })).toBe("runner_chat");
    expect(piRuntimeSurface({
      conversationID: "pi-acceptance-one",
      promptProfile: "acceptance",
      source: "runner_chat"
    })).toBe("internal");
  });

  test("turns observation assembly failures into redacted warnings instead of runtime failures", () => {
    const originalWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (...values: unknown[]) => warnings.push(values.map(String).join(" "));
    try {
      const cleanup = installPiContextBudgetObservation({} as never, {
        conversationID: "runner-chat-failure",
        promptProfile: "chat",
        source: "runner_chat"
      }, {
        baseSystemPrompt: "base",
        compactionReserveTokens: 1024,
        resourceSnapshot: {} as never,
        runtimeContextEnvelope: {} as never,
        session: {
          getActiveToolNames: () => {
            throw new Error("token=fixture-observer-secret");
          }
        } as never
      });

      expect(cleanup).toBeInstanceOf(Function);
      expect(() => cleanup()).not.toThrow();
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("failed to audit context budget observation");
      expect(warnings[0]).not.toContain("fixture-observer-secret");
    } finally {
      console.warn = originalWarn;
    }
  });

  test("observes compaction metadata without storing summaries or error text", () => {
    const payload = buildPiCompactionObservation({
      conversationID: "telegram-chat-compaction",
      promptProfile: "chat",
      source: "runner_chat"
    }, {
      aborted: false,
      errorMessage: "token=must-not-be-stored",
      reason: "threshold",
      result: {
        estimatedTokensAfter: 12000,
        firstKeptEntryId: "entry-2",
        summary: "PRIVATE COMPACTION SUMMARY",
        tokensBefore: 78000,
        usage: {
          cacheRead: 3,
          cacheWrite: 4,
          cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
          input: 10,
          output: 5,
          totalTokens: 22
        }
      },
      type: "compaction_end",
      willRetry: false
    });

    expect(payload).toMatchObject({
      aborted: false,
      error_present: true,
      observe_only: true,
      phase: "compaction_end",
      reason: "threshold",
      result: {
        estimated_tokens_after: 12000,
        tokens_before: 78000,
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 22 }
      },
      surface: "telegram",
      will_retry: false
    });
    expect(JSON.stringify(payload)).not.toContain("PRIVATE COMPACTION SUMMARY");
    expect(JSON.stringify(payload)).not.toContain("must-not-be-stored");
  });
});
