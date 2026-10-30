import { expect, test } from "bun:test";

import { getAgentSession } from "../db/repositories/agentSessions.ts";
import { listStoredEvidence } from "../db/repositories/evidence.ts";
import { listIssueEvents } from "../db/repositories/issueEvents.ts";
import { listIssueRuns } from "../db/repositories/issues.ts";
import { createIssueRun, updateIssueRuntime } from "../db/repositories/issueRuns.ts";
import { updateIssue } from "../db/repositories/issueUpdate.ts";

import {
  fakeProvider,
  codexNotifications,
  runtimeFixture,
  resolved,
  qoderProvider,
  qoderInit,
  qoderResult
} from "./providerRuntimeTestFixtures.ts";

export function registerProviderRuntimeSessionsCases() {
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
}
