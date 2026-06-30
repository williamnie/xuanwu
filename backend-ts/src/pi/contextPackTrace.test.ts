import { describe, expect, test } from "bun:test";
import {
  buildContextPackTrace,
  normalizeContextSources,
  type ContextSourceInput
} from "./contextPackTrace.ts";

describe("PI context pack trace v0", () => {
  test("normalizes, dedupes, and sorts all v0 source families", () => {
    const sources = normalizeContextSources([
      source("memory", " memory:project ", 5, " Project memory "),
      source("runtime", "runtime:heartbeat", 10, "loop status snapshot"),
      source("issue", "559", 50, "old summary", { tokenBudget: 120 }),
      source("external_event", "feishu:msg-1", 30, "User asked from Feishu"),
      source("session", "codex:thread-1", 20, "Latest executor session"),
      source("issue", "559", 90, "Acceptance: deterministic trace", {
        policy: "preserve_raw",
        tokenBudget: 200
      })
    ]);

    expect(sources.map((item) => `${item.source_type}:${item.source_id}`)).toEqual([
      "issue:559",
      "external_event:feishu:msg-1",
      "session:codex:thread-1",
      "runtime:runtime:heartbeat",
      "memory:memory:project"
    ]);
    expect(sources[0]).toMatchObject({
      priority: 90,
      raw_evidence_policy: "preserve_raw",
      source_id: "559",
      source_type: "issue",
      token_budget_hint: 200
    });
    expect(sources[0]?.summary).toContain("Acceptance: deterministic trace");
    expect(sources[0]?.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  test("builds deterministic trace id and hash independent of input order", () => {
    const first = [
      source("session", "codex:thread-1", 20, "executor saw test failure"),
      source("issue", "559", 100, "acceptance criteria", { tokenBudget: 256 })
    ];
    const second = [...first].reverse();

    const firstTrace = buildContextPackTrace(first);
    const secondTrace = buildContextPackTrace(second);

    expect(firstTrace).toEqual(secondTrace);
    expect(firstTrace.kind).toBe("context_pack_trace");
    expect(firstTrace.version).toBe(0);
    expect(firstTrace.trace_id).toMatch(/^context_pack_trace_v0_[0-9a-f]{16}$/);
    expect(firstTrace.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(firstTrace.token_budget_hint).toBe(384);
  });

  test("keeps preserve_raw markers without storing raw evidence in the trace", () => {
    const trace = buildContextPackTrace([{
      raw_evidence: "fatal error with CODEX_API_KEY=fixture-secret",
      raw_evidence_policy: "preserve_raw",
      priority: 100,
      source_id: "559:error",
      source_type: "issue",
      summary: "Critical acceptance failure",
      token_budget_hint: 256
    }]);

    expect(trace.sources[0]).toMatchObject({
      raw_evidence_policy: "preserve_raw",
      source_id: "559:error",
      source_type: "issue"
    });
    expect(JSON.stringify(trace)).not.toContain("fixture-secret");
  });
});

function source(
  source_type: ContextSourceInput["source_type"],
  source_id: string,
  priority: number,
  summary: string,
  options: { policy?: ContextSourceInput["raw_evidence_policy"]; tokenBudget?: number } = {}
): ContextSourceInput {
  return {
    priority,
    raw_evidence_policy: options.policy,
    source_id,
    source_type,
    summary,
    token_budget_hint: options.tokenBudget ?? 128
  };
}
