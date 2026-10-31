import { expect, test } from "bun:test";

import { getAgentSession } from "../db/repositories/agentSessions.ts";

import { listIssueEvents } from "../db/repositories/issueEvents.ts";
import { getIssue, listIssueRuns } from "../db/repositories/issues.ts";

import type { ProviderEvent } from "../providers/types.ts";

import {
  fakeProvider,
  LONG_CHUNKS,
  longSessionProvider,
  runtimeFixture,
  claudePolicyProvider
} from "./providerRuntimeTestFixtures.ts";

export function registerProviderRuntimeRecoveryCases() {
  test("normal mode keeps live hooks and terminal state without persisting stream deltas", async () => {
    const { db, issueId, run } = await runtimeFixture("normal");
    const runtimeEvents: ProviderEvent[] = [];
    const liveEvents: Array<{ type?: string }> = [];

    await run(longSessionProvider(), {
      prompt: "normal logs",
      bus: { publish: (event) => liveEvents.push(event as { type?: string }) },
      onRuntimeEvent: (event) => runtimeEvents.push(event)
    });

    const logEvents = listIssueEvents(db, issueId).filter((event) => event.type === "issue.log");
    expect(runtimeEvents).toHaveLength(514);
    expect(logEvents).toHaveLength(1);
    expect(JSON.parse(logEvents[0]?.payload ?? "{}")).toMatchObject({ raw_method: "turn/completed", status: "completed" });
    expect(liveEvents.filter((event) => event.type === "issue.log")).toHaveLength(1);
    const session = getAgentSession(db, "codex:thread-long");
    expect(session).toMatchObject({ status: "completed" });
    expect(JSON.parse(session?.raw_ref ?? "{}")).toMatchObject({ provider_turn_id: "turn-long" });
  });

  test("replays a long Session from aggregated logs with fewer rows and bytes", async () => {
    const { db, issueId, run } = await runtimeFixture();
    const runtimeEvents: ProviderEvent[] = [];
    const liveEvents: Array<{ type?: string }> = [];

    await run(longSessionProvider(), {
      prompt: "long session",
      bus: { publish: (event) => liveEvents.push(event as { type?: string }) },
      onRuntimeEvent: (event) => runtimeEvents.push(event)
    });

    const logEvents = listIssueEvents(db, issueId).filter((event) => event.type === "issue.log");
    const payloads = logEvents.map((event) => JSON.parse(event.payload) as Record<string, unknown>);
    const replay = payloads.filter((payload) => payload.raw_method === "item/agentMessage/delta").map((payload) => payload.text).join("");
    const storedBytes = db.sqlite.query<{ bytes: number }, [number]>(
      "select sum(length(cast(payload as blob))) as bytes from issue_events where issue_id=? and type='issue.log'"
    ).get(issueId)?.bytes ?? 0;
    const baselineBytes = LONG_CHUNKS.reduce((total, text) => total + Buffer.byteLength(JSON.stringify({
      type: "text",
      provider: "codex",
      raw_method: "item/agentMessage/delta",
      raw_payload: JSON.stringify({ delta: text }),
      text
    })), 0);

    expect(runtimeEvents).toHaveLength(514);
    expect(logEvents).toHaveLength(10);
    expect(liveEvents.filter((event) => event.type === "issue.log")).toHaveLength(10);
    expect(replay).toBe(LONG_CHUNKS.join(""));
    expect(payloads.at(-1)).toMatchObject({ type: "done", raw_method: "turn/completed", status: "completed" });
    expect(getIssue(db, issueId)?.issue_log_mode).toBe("normal");
    expect(storedBytes).toBeLessThan(baselineBytes * 0.35);
  });

  test("P1: execution-only Provider 完成 Attempt 不写 Session", async () => {
    const { db, issueId, run } = await runtimeFixture();
    const events: ProviderEvent[] = [];

    const result = await run(fakeProvider("fake-execution-only", (input, emit) => {
      emit({ type: "provider.message", text: "execution only" });
      return { runId: `p1-execution-${input.issueId}` };
    }), { cwd: "/tmp/p1-execution-only", prompt: "execute", onLog: (event) => events.push(event) });

    expect(result.session).toBeUndefined();
    expect(events.some((event) => event.session !== undefined)).toBe(false);
    expect(listIssueRuns(db, issueId).at(-1)?.provider_session_id ?? "").toBe("");
  });

  test("策略组合不受支持时记录配置错误且不启动 Provider Session", async () => {
    const { db, issueId, run } = await runtimeFixture();
    let runCalls = 0;
    const provider = fakeProvider("claude", () => {
      runCalls += 1;
      return { runId: "must-not-run" };
    }, claudePolicyProvider({ active_sessions: 0, api_key_configured: false, mode: "cli-fallback", ready: true, version: "2.1.221" }));

    await expect(run(provider, {
      prompt: "execute",
      executionPolicyRequest: { contract: "xw.execution-policy.v1", access: "provider-native-development", approval: "ask-sensitive" },
      executionPolicyResolutionSource: "explicit"
    })).rejects.toThrow("cannot provide the required host approval");

    expect(runCalls).toBe(0);
    const latest = listIssueRuns(db, issueId).at(-1);
    expect(latest?.provider_session_id).toBe("");
    expect(JSON.parse(latest?.runtime_metadata_json ?? "{}")).toMatchObject({
      configuration_error: { code: "policy_combination_unsupported" },
      provider: "claude",
      resolution_source: "explicit",
      transport: "stdio-json"
    });
    expect(listIssueEvents(db, issueId).some((event) => event.payload.includes("execution-policy/resolve_error"))).toBe(true);
  });

  test("成功解析时记录 Provider policy capability contract 而不是 resolved policy contract", async () => {
    const { db, issueId, run } = await runtimeFixture();

    await run(fakeProvider("claude", () => ({ runId: "policy-metadata-run" }),
      claudePolicyProvider({ active_sessions: 0, api_key_configured: true, mode: "sdk", ready: true, version: "0.3.152" })), {
      prompt: "execute",
      executionPolicyRequest: { contract: "xw.execution-policy.v1", access: "unrestricted-host", approval: "unattended" },
      executionPolicyResolutionSource: "explicit"
    });

    expect(JSON.parse(listIssueRuns(db, issueId).at(-1)?.runtime_metadata_json ?? "{}")).toMatchObject({
      provider_policy_capability_revision: "xw.provider-execution-policy-capabilities.v1",
      resolved_execution_policy: { contract: "xw.resolved-execution-policy.v1" }
    });
  });
}
