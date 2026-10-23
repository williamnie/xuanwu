import { describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentSession } from "../db/repositories/agentSessions.ts";
import { listStoredEvidence } from "../db/repositories/evidence.ts";
import { listIssueEvents } from "../db/repositories/issueEvents.ts";
import { getIssue, listIssueRuns } from "../db/repositories/issues.ts";
import { createIssueRun, updateIssueRuntime } from "../db/repositories/issueRuns.ts";
import { updateIssue } from "../db/repositories/issueUpdate.ts";
import { runIssueWithProvider as runIssueWithProviderRuntime } from "./providerRuntime.ts";
import { isExecutorProviderId } from "../providers/types.ts";
import { normalizeCodexEvent } from "../providers/codex/events.ts";
import type { ExecutorProvider, ExecutorProviderId, ProviderEvent, ProviderRunInput, ProviderRunResult } from "../providers/types.ts";
import type { SDKResultMessage, SDKSystemInitMessage } from "@qoder-ai/qoder-agent-sdk";
import { buildConfig } from "../config/env.ts";
import { QoderExecutorProvider } from "../providers/qoder/provider.ts";
import { createFakeQoderSdkFacade } from "../providers/qoder/sdkFacade.ts";
import { claudeManifest } from "../providers/claude/factory.ts";
import { claudeExecutionPolicyAdapter } from "../providers/claude/executionPolicy.ts";
import { insertIssue, insertProject, useTestDatabase } from "../testing/harness.ts";

const openFixtureDatabase = useTestDatabase();
const FAKE_SESSION = { provider: "fake-execution-only" as ExecutorProviderId, sessionId: "fake-session", turnId: "fake-turn" };

/** An executor whose run emits through `emit` (provider id filled in) and returns the script's result. */
function fakeProvider(
  id: string,
  script: (input: ProviderRunInput, emit: (event: Omit<ProviderEvent, "provider">) => void) => ProviderRunResult | Promise<ProviderRunResult>,
  extra: Partial<ExecutorProvider> = {}
): ExecutorProvider {
  const provider = id as ExecutorProviderId;
  return {
    id: provider,
    capabilities: ["issue_execution"],
    ...extra,
    async run(input) {
      return script(input, (event) => input.onEvent?.({ ...event, provider }));
    }
  };
}

/** Logs one message on the fixed fake session. */
const loggingProvider = (inputs: ProviderRunInput[] = []) => fakeProvider("fake-execution-only", (input, emit) => {
  inputs.push(input);
  emit({ type: "provider.message", session: FAKE_SESSION, text: "fake provider log" });
  return { runId: "fake-run", session: FAKE_SESSION };
});

/** Replays Codex app-server notifications through the real normalizer. */
const codexNotifications = (sessionId: string, turnId: string, notifications: () => Array<{ method: string; params: Record<string, unknown> }>) =>
  fakeProvider("codex", (input) => {
    notifications().forEach((notification) => input.onEvent?.(normalizeCodexEvent(notification)));
    return { runId: `codex:${sessionId}:${turnId}`, session: { provider: "codex", sessionId, turnId } };
  });

const LONG_CHUNKS = Array.from({ length: 513 }, (_, index) => `chunk-${String(index).padStart(3, "0")}\n`);
const longSessionProvider = () => fakeProvider("codex", (_input, emit) => {
  const session = { provider: "codex" as const, sessionId: "thread-long", turnId: "turn-long" };
  for (const text of LONG_CHUNKS) {
    emit({ type: "text", session, text, raw: { method: "item/agentMessage/delta", payload: JSON.stringify({ delta: text }) } });
  }
  emit({
    type: "done",
    status: "completed",
    session,
    raw: { method: "turn/completed", payload: JSON.stringify({ turn: { id: "turn-long", status: "completed" } }) }
  });
  return { runId: "codex:thread-long:turn-long", session };
});

describe("executor provider runtime seam", () => {
  test("flushes artifact logs in source order before terminal reconciliation and snapshots mutable inputs", async () => {
    const { db, issueId, run } = await runtimeFixture();
    const source: ProviderEvent = { provider: "codex", type: "raw", text: "original".repeat(12_000), raw: { method: "custom/large" } };
    const original = source.text;

    await run(fakeProvider("codex", (input, emit) => {
      input.onEvent?.(source);
      source.text = "mutated";
      emit({ type: "raw", text: "second", raw: { method: "custom/small" } });
      emit({ type: "done", status: "completed", raw: { method: "turn/completed" } });
      return { runId: "ordered" };
    }), { prompt: "ordered" });

    const events = listIssueEvents(db, issueId);
    const logs = events.filter((event) => event.type === "issue.log");
    expect(logs.map((event) => JSON.parse(event.payload).text)).toEqual([original, "second", undefined]);
    const acceptance = events.find((event) => event.type === "issue.pi_acceptance_requested.v1");
    expect(acceptance).toBeDefined();
    expect(acceptance!.id).toBeGreaterThan(logs.at(-1)!.id);
  });

  test("artifact I/O failure rejects Run flush and prevents success reconciliation", async () => {
    const { db, issueId, run } = await runtimeFixture();
    const root = join(dirname(db.path), "artifacts");
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "issue-logs"), "not a directory");
    let completed = false;

    await expect(run(fakeProvider("codex", (_input, emit) => {
      emit({ type: "raw", text: "x".repeat(100_000), raw: { method: "custom/large" } });
      emit({ type: "done", status: "completed", raw: { method: "turn/completed" } });
      return { runId: "must-fail-flush" };
    }), { prompt: "failure", onRunComplete: () => { completed = true; } })).rejects.toThrow();

    expect(completed).toBe(false);
    expect(listIssueEvents(db, issueId).filter((event) => event.type === "issue.pi_acceptance_requested.v1")).toHaveLength(0);
    expect(listIssueRuns(db, issueId).at(-1)?.ended_at).toBe("");
    expect(getIssue(db, issueId)?.issue_log_mode).toBe("normal");
  });

  test("P10: Pi 已是 executor provider id（RPC adapter 注册后）", () => {
    expect(isExecutorProviderId("pi")).toBe(true);
  });

  test("runner layer can execute a fake provider and observe session refs/events", async () => {
    const inputs: ProviderRunInput[] = [];
    const events: ProviderEvent[] = [];

    const result = await runIssueWithProvider(loggingProvider(inputs), {
      issueId: 154,
      projectId: "xuanwu",
      cwd: "/tmp/project",
      prompt: "issue prompt",
      model: "codex-default",
      approvalPolicy: "never",
      serviceTier: "priority",
      sandbox: "workspace-write",
      onLog: (event) => events.push(event)
    });

    expect(inputs[0]).toMatchObject({ issueId: 154, projectId: "xuanwu", serviceTier: "priority" });
    expect(result).toEqual({ runId: "fake-run", session: FAKE_SESSION });
    expect(events).toEqual([{ provider: "fake-execution-only", type: "provider.message", text: "fake provider log", session: FAKE_SESSION }]);
  });

  test("runtime hooks persist start, events, and final provider session refs", async () => {
    const calls: Array<[string, unknown]> = [];

    const result = await runIssueWithProvider(loggingProvider(), {
      issueId: 159,
      projectId: "demo",
      cwd: "/tmp/project",
      prompt: "issue prompt",
      onRunStart: (input) => calls.push(["start", input]),
      onRuntimeEvent: (event) => calls.push(["event", event]),
      onRunComplete: (output) => calls.push(["complete", output])
    });

    expect(result.session).toEqual(FAKE_SESSION);
    expect(calls).toEqual([
      ["start", { provider: "fake-execution-only", issueId: 159, projectId: "demo", metadata: { cwd: "/tmp/project" } }],
      ["event", { provider: "fake-execution-only", type: "provider.message", text: "fake provider log", session: FAKE_SESSION }],
      ["complete", { provider: "fake-execution-only", issueId: 159, projectId: "demo", runId: "fake-run", session: FAKE_SESSION }]
    ]);
  });

  test("normalizes thrown provider failures when no wire error was emitted", async () => {
    const events: ProviderEvent[] = [];

    await expect(runIssueWithProvider(fakeProvider("codex", () => {
      throw new Error("provider failed CODEX_API_KEY=fixture-secret");
    }), {
      issueId: 160,
      projectId: "demo",
      cwd: "/tmp/project",
      prompt: "issue prompt",
      onLog: (event) => events.push(event)
    })).rejects.toThrow("provider failed");

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      error: "provider failed CODEX_API_KEY=[redacted]",
      raw: { method: "provider/run_error" },
      runEvent: { kind: "error", outcome: "failed", terminal: true },
      status: "failed",
      type: "error"
    });
    expect(JSON.stringify(events)).not.toContain("fixture-secret");
  });

  test("persists an early Pi Session even when the provider later fails", async () => {
    const { db, issueId, run } = await runtimeFixture();

    await expect(run(fakeProvider("pi-coding-agent", (_input, emit) => {
      const session = { provider: "pi-coding-agent" as ExecutorProviderId, sessionId: "pi-durable-session" };
      emit({ session, status: "running", type: "provider.session_started" });
      emit({ session, status: "failed", error: "idle timeout", type: "error" });
      throw new Error("idle timeout");
    }, { capabilities: ["issue_execution", "sessions"] }))).rejects.toThrow("idle timeout");

    expect(listIssueRuns(db, issueId).at(-1)).toMatchObject({
      provider: "pi-coding-agent",
      provider_session_id: "pi-durable-session",
      provider_turn_id: ""
    });
    expect(getAgentSession(db, "pi-coding-agent:pi-durable-session")).toMatchObject({
      issue_id: issueId,
      provider: "pi-coding-agent",
      provider_session_id: "pi-durable-session",
      status: "failed"
    });
  });

  test("persists provider session refs into issue_runs and agent_sessions", async () => {
    const { db, issueId, run } = await runtimeFixture();

    await run(loggingProvider(), { serviceTier: "priority", serviceTierSource: "issue" });

    const metadata = { run_id: "fake-run", ...resolved({ service_tier: "priority", service_tier_source: "issue" }), service_tier: "priority", service_tier_source: "issue" };
    expect(listIssueRuns(db, issueId)).toMatchObject([{
      attempt: 1,
      provider: "fake-execution-only",
      provider_session_id: "fake-session",
      provider_turn_id: "fake-turn",
      codex_thread_id: "",
      codex_turn_id: "",
      runtime_metadata_json: JSON.stringify(metadata)
    }]);
    expect(getAgentSession(db, "fake-execution-only:fake-session")).toMatchObject({
      provider: "fake-execution-only",
      provider_session_id: "fake-session",
      project_id: "demo",
      issue_id: issueId,
      raw_ref: JSON.stringify({ provider_turn_id: "fake-turn", ...metadata })
    });
    const issueEvents = listIssueEvents(db, issueId, { types: ["issue.log"] });
    expect(issueEvents).toMatchObject([{ issue_id: issueId, type: "issue.log" }]);
    expect(JSON.parse(issueEvents[0]!.payload)).toMatchObject({
      provider: "fake-execution-only",
      runtime_evidence_correlation: {
        attempt_id: "xw:run:issue_runs:issue-1-attempt-1~attempt:1",
        contract: "xw.runtime-evidence-correlation.v1",
        issue_run_id: "issue-1-attempt-1",
        run_id: "xw:run:issue_runs:issue-1-attempt-1"
      },
      text: "fake provider log",
      type: "provider.message"
    });
  });

  test("Qoder init persists a recoverable Session before an SDK failure", async () => {
    const { db, issueId, run } = await runtimeFixture();
    const sessionId = "qoder-early-session";

    await expect(run(qoderProvider(sessionId, "qoder-inv-early", [qoderInit(sessionId), "throw"]))).rejects.toThrow("sdk failure");

    expect(listIssueRuns(db, issueId).at(-1)).toMatchObject({ provider: "qoder", provider_session_id: sessionId, provider_turn_id: "" });
    expect(getAgentSession(db, `qoder:${sessionId}`)).toMatchObject({
      issue_id: issueId,
      provider: "qoder",
      provider_session_id: sessionId,
      status: "failed"
    });
  });

  test("Qoder main result persists invocation, Session and message refs through the existing runtime", async () => {
    const { db, issueId, run } = await runtimeFixture();
    const sessionId = "qoder-terminal-session";

    const result = await run(qoderProvider(sessionId, "qoder-inv-terminal", [qoderInit(sessionId), qoderResult(sessionId)]));

    expect(result).toEqual({ runId: "qoder-inv-terminal", session: { provider: "qoder", sessionId, turnId: "qoder-result-1" } });
    expect(listIssueRuns(db, issueId).at(-1)).toMatchObject({
      provider: "qoder",
      provider_session_id: sessionId,
      provider_turn_id: "qoder-result-1",
      runtime_metadata_json: JSON.stringify({ run_id: "qoder-inv-terminal", ...resolved() })
    });
    expect(JSON.parse(getAgentSession(db, `qoder:${sessionId}`)?.raw_ref ?? "{}")).toEqual({
      provider_turn_id: "qoder-result-1",
      run_id: "qoder-inv-terminal",
      ...resolved()
    });
  });

  test("keeps completed PTY output as an artifact without synthesizing verification Evidence", async () => {
    const { db, issueId, run } = await runtimeFixture();
    const [threadId, turnId, itemId, processId] = ["thread-verification", "turn-verification", "command-verification", "process-verification"];

    await run(codexNotifications(threadId, turnId, () => [
      { method: "turn/started", params: { threadId, turn: { id: turnId } } },
      { method: "item/commandExecution/terminalInteraction", params: { itemId, processId, stdin: "", threadId, turnId } },
      {
        method: "item/completed",
        params: {
          completedAtMs: Date.now(),
          item: {
            aggregatedOutput: "1 pass\n".repeat(2_000),
            command: "bun test src/runner/providerRuntime.test.ts",
            commandActions: [{ type: "unknown", command: "bun test src/runner/providerRuntime.test.ts" }],
            cwd: "/tmp/project",
            durationMs: 10,
            exitCode: 0,
            id: itemId,
            processId,
            status: "completed",
            type: "commandExecution"
          },
          threadId,
          turnId
        }
      },
      { method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed" } } }
    ]), { prompt: "run verification" });

    const completed = db.sqlite.query<{ payload: string }, [number]>(`
      select payload from issue_events where issue_id=? and type='issue.log'
        and json_extract(payload, '$.raw_method')='item/completed' limit 1
    `).get(issueId);
    expect(listStoredEvidence(db, { issue_ids: [issueId], limit: 10 }).items).toHaveLength(0);
    expect(JSON.parse(completed?.payload ?? "{}")).toMatchObject({
      issue_log_artifact: { schema_version: "issue-log-payload-artifact.v1" }
    });
  });

  test("persists normalized provider evidence and projects audited usage without acting on unknown events", async () => {
    const { db, issueId, run } = await runtimeFixture();
    const [threadId, turnId] = ["thread-normalized", "turn-normalized"];

    await run(codexNotifications(threadId, turnId, () => [
      { method: "turn/started", params: { threadId, turn: { id: turnId } } },
      { method: "future/event", params: { threadId, turnId, opaque: true } },
      {
        method: "thread/tokenUsage/updated",
        params: {
          threadId,
          turnId,
          tokenUsage: {
            last: { cachedInputTokens: 1, inputTokens: 4, outputTokens: 2, reasoningOutputTokens: 1, totalTokens: 6 },
            total: { cachedInputTokens: 3, inputTokens: 12, outputTokens: 5, reasoningOutputTokens: 2, totalTokens: 17 }
          }
        }
      },
      { method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed" } } }
    ]), { prompt: "normalized fixture" });

    const payloads = listIssueEvents(db, issueId).map((event) => ({ event, payload: JSON.parse(event.payload) as Record<string, unknown> }));
    const unknown = payloads.find(({ payload }) => payload.raw_method === "future/event");
    const usage = payloads.find(({ payload }) => payload.raw_method === "thread/tokenUsage/updated");
    const attempt = db.sqlite.query<{ cost_json: string; revision: number; status: string }, [number]>(`
      select attempt.cost_json, attempt.revision, attempt.status
      from run_attempts attempt join issue_runs run on run.id=attempt.issue_run_id
      where run.issue_id=?
    `).get(issueId);
    const cost = JSON.parse(attempt?.cost_json ?? "{}") as Record<string, unknown>;

    expect(unknown?.payload.run_event).toMatchObject({ kind: "unknown", outcome: "unknown", terminal: false, unknown: { policy: "preserve" } });
    expect(attempt).toMatchObject({ status: "succeeded", revision: 1 });
    expect(cost).toMatchObject({
      money: { amount_micros: null, basis: "unavailable", currency: "" },
      usage: { cached_input_tokens: 3, completeness: "complete", input_tokens: 12, output_tokens: 5, reasoning_output_tokens: 2, total_tokens: 17 }
    });
    expect((cost.source_refs as string[])).toEqual(expect.arrayContaining([
      "provider-event:codex:thread/tokenUsage/updated:thread-normalized:turn-normalized",
      `issue_events:${usage?.event.id}`
    ]));
  });

  test("persists Codex thread idle status without raw telemetry flipping it back to running", async () => {
    const { db, issueId, run } = await runtimeFixture();

    await run(fakeProvider("codex", (_input, emit) => {
      const session = { provider: "codex" as const, sessionId: "thread-idle", turnId: "turn-idle" };
      emit({ raw: { method: "turn/started" }, session, status: "inProgress", type: "text" });
      emit({ raw: { method: "thread/status/changed" }, session: { provider: "codex", sessionId: "thread-idle" }, status: "idle", type: "raw" });
      emit({ raw: { method: "thread/tokenUsage/updated" }, session, type: "raw" });
      return { runId: "codex:thread-idle:turn-idle", session };
    }));

    expect(getAgentSession(db, "codex:thread-idle")).toMatchObject({
      issue_id: issueId,
      provider: "codex",
      provider_session_id: "thread-idle",
      status: "idle"
    });
    expect(listIssueRuns(db, issueId)).toMatchObject([{ provider: "codex", provider_session_id: "thread-idle", provider_turn_id: "turn-idle" }]);
  });

  test("keeps a Claude run separate from stale Codex thread fields when status is closed during execution", async () => {
    const { db, issueId, run } = await runtimeFixture();
    const codexRun = createIssueRun(db, issueId);
    updateIssueRuntime(db, issueId, {
      provider: "codex",
      provider_session_id: "codex-thread",
      provider_turn_id: "codex-turn",
      metadata: { run_id: "codex-run" }
    });
    db.sqlite.run("update issue_runs set ended_at=?, status=? where id=?", ["2026-01-01T00:00:00Z", "done", codexRun.id]);

    await run(fakeProvider("claude", (input) => {
      updateIssue(db, input.issueId, { status: "done", error: "" });
      return { runId: "claude-run", session: { provider: "claude", sessionId: "claude-session", turnId: "claude-turn" } };
    }));

    expect(listIssueRuns(db, issueId)).toMatchObject([
      {
        attempt: 1,
        provider: "codex",
        provider_session_id: "codex-thread",
        provider_turn_id: "codex-turn",
        codex_thread_id: "codex-thread",
        codex_turn_id: "codex-turn",
        runtime_metadata_json: "{\"run_id\":\"codex-run\"}"
      },
      {
        attempt: 2,
        status: "done",
        provider: "claude",
        provider_session_id: "claude-session",
        provider_turn_id: "claude-turn",
        codex_thread_id: "",
        codex_turn_id: "",
        exit_reason: "pi_semantic_decision",
        runtime_metadata_json: JSON.stringify({ run_id: "claude-run", ...resolved() })
      }
    ]);
    expect(getAgentSession(db, "claude:claude-session")).toMatchObject({
      provider: "claude",
      provider_session_id: "claude-session",
      issue_id: issueId,
      raw_ref: JSON.stringify({ provider_turn_id: "claude-turn", run_id: "claude-run", ...resolved() })
    });
  });

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
});

/** Runs through the real runtime, attaching the open (or a new) Run like the project loop does. */
function runIssueWithProvider(
  provider: Parameters<typeof runIssueWithProviderRuntime>[0],
  input: Parameters<typeof runIssueWithProviderRuntime>[1]
) {
  if (!input.database || input.issueRunId) return runIssueWithProviderRuntime(provider, input);
  const current = listIssueRuns(input.database, input.issueId).filter((run) => run.ended_at === "").at(-1)
    ?? createIssueRun(input.database, input.issueId);
  return runIssueWithProviderRuntime(provider, { ...input, issueRunId: current.id });
}

/** An in-progress "demo" Issue and a `run(provider, overrides)` bound to it. */
async function runtimeFixture(issueLogMode: "debug" | "normal" = "debug") {
  const db = await openFixtureDatabase();
  insertProject(db, "demo");
  const issueId = insertIssue(db, { title: "Runtime", status: "in_progress", issue_log_mode: issueLogMode });
  const run = (provider: ExecutorProvider, overrides: Partial<Parameters<typeof runIssueWithProviderRuntime>[1]> = {}) =>
    runIssueWithProvider(provider, { database: db, issueId, projectId: "demo", cwd: "/tmp/project", prompt: "issue prompt", ...overrides });
  return { db, issueId, run };
}

function resolved(overrides: Record<string, string> = {}) {
  return {
    resolved_settings: {
      approval_policy: "", model: "", reasoning_effort: "", sandbox: "", service_tier: "", service_tier_source: "standard", ...overrides
    }
  };
}

function claudePolicyProvider(status: Record<string, unknown>): Partial<ExecutorProvider> {
  return {
    manifest: claudeManifest(),
    policyAdapter: claudeExecutionPolicyAdapter,
    runtimeStatus: () => status
  } as Partial<ExecutorProvider>;
}

function qoderProvider(sessionId: string, invocationId: string, script: Parameters<typeof createFakeQoderSdkFacade>[0]): QoderExecutorProvider {
  return new QoderExecutorProvider(buildConfig().providers.qoder!, {
    facade: createFakeQoderSdkFacade(script).facade,
    invocationIdFactory: () => invocationId,
    readiness: {
      installed: true,
      ready: true,
      status: { active_sessions: 0, api_key_configured: true, mode: "sdk", ready: true, version: "1.0.23" }
    },
    sessionIdFactory: () => sessionId
  });
}

function qoderInit(sessionId: string): SDKSystemInitMessage {
  return {
    type: "system",
    subtype: "init",
    apiKeySource: "none",
    qodercli_version: "1.1.23",
    protocol_version: "1.2.0",
    cwd: "/tmp/project",
    tools: [],
    mcp_servers: [],
    model: "performance",
    permissionMode: "dontAsk",
    slash_commands: [],
    output_style: "default",
    skills: [],
    plugins: [],
    uuid: "qoder-init-1",
    session_id: sessionId
  };
}

function qoderResult(sessionId: string): SDKResultMessage {
  return {
    type: "result",
    subtype: "success",
    duration_ms: 12,
    duration_api_ms: 8,
    is_error: false,
    num_turns: 1,
    result: "ok",
    stop_reason: "end_turn",
    total_cost_usd: 0,
    usage: {
      cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      inference_geo: "",
      input_tokens: 1,
      iterations: [],
      output_tokens: 1,
      server_tool_use: { web_fetch_requests: 0, web_search_requests: 0 },
      service_tier: "",
      speed: ""
    },
    modelUsage: {},
    permission_denials: [],
    uuid: "qoder-result-1",
    session_id: sessionId
  };
}
