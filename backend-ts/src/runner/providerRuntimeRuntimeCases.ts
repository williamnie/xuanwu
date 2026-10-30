import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentSession } from "../db/repositories/agentSessions.ts";

import { listIssueEvents } from "../db/repositories/issueEvents.ts";
import { getIssue, listIssueRuns } from "../db/repositories/issues.ts";

import { isExecutorProviderId } from "../providers/types.ts";

import type { ExecutorProviderId, ProviderEvent, ProviderRunInput } from "../providers/types.ts";

import {
  FAKE_SESSION,
  fakeProvider,
  loggingProvider,
  runIssueWithProvider,
  runtimeFixture,
  resolved
} from "./providerRuntimeTestFixtures.ts";

export function registerProviderRuntimeRuntimeCases() {
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
}
