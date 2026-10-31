import type { ProviderEvent } from "../providers/types.ts";

export const session = { provider: "codex" as const, sessionId: "thread-long", turnId: "turn-long" };

export function costEvent(totalTokens: number): ProviderEvent {
  return {
    provider: "codex",
    type: "raw",
    session,
    raw: { method: "thread/tokenUsage/updated", payload: JSON.stringify({ total_tokens: totalTokens }) },
    runEvent: {
      contract: "xw.run-event.v1",
      cost: {
        money: { amount_micros: null, basis: "unavailable", currency: "" },
        pricing_refs: [],
        source_refs: [`usage:${totalTokens}`],
        usage: {
          cached_input_tokens: 0,
          completeness: "complete",
          input_tokens: totalTokens,
          output_tokens: 0,
          reasoning_output_tokens: 0,
          total_tokens: totalTokens
        }
      },
      kind: "progress",
      metadata: { usage_scope: "provider_session_total" },
      outcome: "running",
      provider: "codex",
      source: { method: "thread/tokenUsage/updated", ref: `usage:${totalTokens}` },
      terminal: false
    }
  };
}
