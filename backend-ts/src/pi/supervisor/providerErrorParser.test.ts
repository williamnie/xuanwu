import { describe, expect, test } from "bun:test";
import {
  parseIssueEventProviderError,
  parseProviderErrorSignal,
  parseProviderEventError,
  parseProviderHealthSignal
} from "./providerErrorParser.ts";

const NOW = new Date("2026-06-10T02:00:00Z");

describe("provider error parser", () => {
  test("classifies issue #298 reconnecting text as stream disconnect", () => {
    expect(parseIssueEventProviderError({
      type: "error",
      provider: "codex",
      raw_payload: "Reconnecting... 1/5",
      error: "stream disconnected before completion"
    }, { now: NOW })).toMatchObject({
      category: "stream_disconnect",
      diagnosis_code: "executor_stream_disconnected",
      provider: "codex"
    });
  });

  test("parses 429 retry-after seconds from normalized provider error", () => {
    expect(parseProviderEventError({
      provider: "codex",
      type: "error",
      error: "HTTP 429: too many requests; try again in 42s"
    }, { now: NOW })).toMatchObject({
      category: "rate_limit",
      diagnosis_code: "provider_retry_after_waiting",
      retry_after_at: "2026-06-10T02:00:42Z",
      retry_after_seconds: 42,
      status_code: 429
    });
  });

  test("parses JSON raw payload retry/reset fields and redacts sensitive summary", () => {
    const signal = parseIssueEventProviderError({
      raw_payload: JSON.stringify({
        error: "rate limit for token=abc at /Users/demo/private.txt",
        model: "gpt-test",
        retry_after_ms: 42000,
        service_tier: "priority",
        status_code: 429
      })
    }, { now: NOW });

    expect(signal).toMatchObject({
      category: "rate_limit",
      model: "gpt-test",
      retry_after_at: "2026-06-10T02:00:42Z",
      service_tier: "priority",
      status_code: 429
    });
    expect(signal.raw_summary).not.toContain("abc");
    expect(signal.raw_summary).not.toContain("/Users/demo/private.txt");
  });

  test("parses HTTP Retry-After date header", () => {
    expect(parseProviderErrorSignal({
      headers: { "Retry-After": "Wed, 10 Jun 2026 02:10:00 GMT" },
      rawPayload: "HTTP 429 rate limit"
    }, { now: NOW })).toMatchObject({
      category: "rate_limit",
      retry_after_at: "2026-06-10T02:10:00Z",
      retry_after_seconds: 600,
      status_code: 429
    });
  });

  test("classifies Codex serverOverloaded capacity errors as transient rate limits", () => {
    expect(parseProviderEventError({
      provider: "codex",
      type: "error",
      status: "failed",
      error: "Selected model is at capacity. Please try a different model.",
      raw: {
        method: "error",
        payload: JSON.stringify({
          error: {
            codexErrorInfo: "serverOverloaded",
            message: "Selected model is at capacity. Please try a different model."
          },
          willRetry: false
        })
      }
    }, { now: NOW })).toMatchObject({
      category: "rate_limit",
      diagnosis_code: "provider_rate_limited",
      provider: "codex",
      raw_summary: "Selected model is at capacity. Please try a different model."
    });
  });

  test("classifies 429 without retry-after as rate limited but leaves wait window to policy cooldown", () => {
    expect(parseProviderEventError({
      provider: "codex",
      type: "error",
      error: "HTTP 429: too many requests"
    }, { now: NOW })).toMatchObject({
      category: "rate_limit",
      diagnosis_code: "provider_rate_limited",
      raw_summary: "HTTP 429: too many requests",
      status_code: 429
    });
    expect(parseProviderEventError({
      provider: "codex",
      type: "error",
      error: "HTTP 429: too many requests"
    }, { now: NOW }).retry_after_at).toBeUndefined();
  });

  test("parses provider health rate limit reset snapshot", () => {
    expect(parseProviderHealthSignal({
      provider: "codex",
      rate_limited: true,
      rate_limits: {
        primary: {
          limit_id: "primary",
          reset_at: "2026-06-10T02:15:00Z"
        }
      }
    }, { now: NOW })).toMatchObject({
      category: "rate_limit",
      limit_id: "primary",
      provider: "codex",
      rate_limit_reset_at: "2026-06-10T02:15:00Z",
      retry_after_at: "2026-06-10T02:15:00Z"
    });
  });

  test("ignores ordinary completed issue log output even when it contains provider-looking words", () => {
    expect(parseIssueEventProviderError({
      command: "bun test",
      raw_payload: "source says unauthorized, approval denied, validation failed, rate limit",
      status: "completed",
      text: "completed command output: permission denied is just fixture text",
      type: "tool"
    }, { now: NOW })).toMatchObject({
      category: "unknown"
    });
  });

  test("ignores completed provider command output before it is persisted as issue log", () => {
    expect(parseProviderEventError({
      provider: "codex",
      type: "tool",
      command: "bun test",
      raw: {
        method: "item/commandExecution/outputDelta",
        payload: {
          delta: "unauthorized approval denied validation failed provider error",
          status: "completed"
        }
      },
      status: "completed",
      text: "unauthorized approval denied validation failed provider error"
    }, { now: NOW })).toMatchObject({
      category: "unknown"
    });
  });

  test("ignores failed command lifecycle events while the Codex turn can continue", () => {
    const issueLogPayload = {
      command: "/bin/zsh -lc \"cd backend-ts && bun test src/pi/verificationEvidence.test.ts\"",
      provider: "codex",
      raw_method: "item/completed",
      status: "failed",
      text: "! command failed: /bin/zsh -lc \"cd backend-ts && bun test src/pi/verificationEvidence.test.ts\"",
      type: "tool"
    };

    expect(parseIssueEventProviderError(issueLogPayload, { now: NOW })).toMatchObject({
      category: "unknown"
    });
    expect(parseProviderEventError({
      provider: "codex",
      type: "tool",
      command: issueLogPayload.command,
      raw: { method: "item/completed", payload: issueLogPayload },
      status: "failed",
      text: issueLogPayload.text
    }, { now: NOW })).toMatchObject({
      category: "unknown"
    });
  });

  test("keeps structured terminal provider failures eligible for incidents", () => {
    expect(parseIssueEventProviderError({
      error: "API returned 401 unauthorized",
      raw_method: "turn/completed",
      status: "failed",
      type: "done"
    }, { now: NOW })).toMatchObject({
      category: "auth",
      diagnosis_code: "requires_human_decision",
      status_code: 401
    });
  });

  test("does not scan failed turn raw payload completed command output for provider-looking words", () => {
    expect(parseIssueEventProviderError({
      error: "turn failed without structured provider error",
      raw_method: "turn/completed",
      raw_payload: {
        turn: {
          id: "turn-1",
          items: [{
            command: "cat fixture.log",
            output: "unauthorized approval denied validation failed provider error",
            status: "completed",
            type: "commandExecution"
          }, {
            diff: "+ const fixture = 'provider error unauthorized';",
            status: "completed",
            type: "fileChange"
          }],
          status: "failed"
        }
      },
      status: "failed",
      type: "done"
    }, { now: NOW })).toMatchObject({
      category: "unknown"
    });
  });

  test("keeps failed turn top-level structured error while ignoring nested completed output text", () => {
    expect(parseIssueEventProviderError({
      error: "HTTP 429: too many requests",
      raw_method: "turn/completed",
      raw_payload: {
        turn: {
          items: [{
            output: "API returned 401 unauthorized in a completed fixture",
            status: "completed",
            type: "commandExecution"
          }],
          status: "failed"
        }
      },
      status: "failed",
      type: "done"
    }, { now: NOW })).toMatchObject({
      category: "rate_limit",
      diagnosis_code: "provider_rate_limited",
      status_code: 429
    });
  });

  test("classifies auth, permission, and quota failures as human-decision signals", () => {
    expect(parseProviderEventError({
      provider: "codex",
      type: "error",
      error: "API returned 401 unauthorized"
    }, { now: NOW })).toMatchObject({
      category: "auth",
      diagnosis_code: "requires_human_decision",
      status_code: 401
    });
    expect(parseProviderEventError({
      provider: "codex",
      type: "error",
      error: "permission denied"
    }, { now: NOW })).toMatchObject({
      category: "permission",
      diagnosis_code: "requires_human_decision"
    });
    expect(parseProviderEventError({
      provider: "codex",
      type: "error",
      error: "insufficient quota"
    }, { now: NOW })).toMatchObject({
      category: "quota",
      diagnosis_code: "requires_human_decision"
    });
  });

  test("classifies temporary body decode and network failures", () => {
    expect(parseProviderEventError({
      provider: "codex",
      type: "error",
      error: "error decoding response body: unexpected EOF"
    }, { now: NOW })).toMatchObject({
      category: "network",
      diagnosis_code: "provider_transient_network_error"
    });
  });

  test("classifies test and business failures as human-only instead of transient recovery", () => {
    for (const error of [
      "focused tests failed: expected 200 but received 500",
      "business failure: user input validation failed",
      "command failed with exit status 1"
    ]) {
      expect(parseProviderEventError({ provider: "codex", type: "error", error }, { now: NOW })).toMatchObject({
        category: "business_failure",
        diagnosis_code: "requires_human_decision"
      });
    }
  });
});
