import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { getAgentSession } from "../db/repositories/agentSessions.ts";
import { listStoredEvidence } from "../db/repositories/evidence.ts";
import { listIssueEvents } from "../db/repositories/issueEvents.ts";
import { getIssue, listIssueRuns } from "../db/repositories/issues.ts";
import { createIssueRun, updateIssueRuntime } from "../db/repositories/issueRuns.ts";
import { updateIssue } from "../db/repositories/issueUpdate.ts";
import { runIssueWithProvider } from "./providerRuntime.ts";
import { isExecutorProviderId } from "../providers/types.ts";
import { normalizeCodexEvent } from "../providers/codex/events.ts";
import type { ExecutorProvider, ProviderEvent, ProviderRunInput } from "../providers/types.ts";

const tempRoots: string[] = [];

class FakeExecutionProvider implements ExecutorProvider {
  readonly id = "fake-execution-only" as const;
  readonly capabilities = ["issue_execution"] as const;
  lastInput?: ProviderRunInput;

  async run(input: ProviderRunInput) {
    this.lastInput = input;
    input.onEvent?.({
      provider: this.id,
      type: "provider.message",
      session: { provider: this.id, sessionId: "fake-session", turnId: "fake-turn" },
      text: "fake provider log"
    });
    return {
      runId: "fake-run",
      session: { provider: this.id, sessionId: "fake-session", turnId: "fake-turn" }
    };
  }
}


class IdleStatusProvider implements ExecutorProvider {
  readonly id = "codex" as const;
  readonly capabilities = ["issue_execution"] as const;

  async run(input: ProviderRunInput) {
    input.onEvent?.({
      provider: this.id,
      raw: { method: "turn/started" },
      session: { provider: this.id, sessionId: "thread-idle", turnId: "turn-idle" },
      status: "inProgress",
      type: "text"
    });
    input.onEvent?.({
      provider: this.id,
      raw: { method: "thread/status/changed" },
      session: { provider: this.id, sessionId: "thread-idle" },
      status: "idle",
      type: "raw"
    });
    input.onEvent?.({
      provider: this.id,
      raw: { method: "thread/tokenUsage/updated" },
      session: { provider: this.id, sessionId: "thread-idle", turnId: "turn-idle" },
      type: "raw"
    });
    return {
      runId: "codex:thread-idle:turn-idle",
      session: { provider: this.id, sessionId: "thread-idle", turnId: "turn-idle" }
    };
  }
}

class ClosingClaudeProvider implements ExecutorProvider {
  readonly id = "claude" as const;
  readonly capabilities = ["issue_execution"] as const;

  constructor(private readonly db: RunnerDatabase) {}

  async run(input: ProviderRunInput) {
    updateIssue(this.db, input.issueId, { status: "done", error: "" });
    return {
      runId: "claude-run",
      session: { provider: this.id, sessionId: "claude-session", turnId: "claude-turn" }
    };
  }
}

class LongSessionProvider implements ExecutorProvider {
  readonly id = "codex" as const;
  readonly capabilities = ["issue_execution"] as const;
  readonly chunks = Array.from({ length: 513 }, (_, index) => `chunk-${String(index).padStart(3, "0")}\n`);

  async run(input: ProviderRunInput) {
    const session = { provider: this.id, sessionId: "thread-long", turnId: "turn-long" };
    for (const text of this.chunks) {
      input.onEvent?.({
        provider: this.id,
        type: "text",
        session,
        text,
        raw: { method: "item/agentMessage/delta", payload: JSON.stringify({ delta: text }) }
      });
    }
    input.onEvent?.({
      provider: this.id,
      type: "done",
      status: "completed",
      session,
      raw: { method: "turn/completed", payload: JSON.stringify({ turn: { id: "turn-long", status: "completed" } }) }
    });
    return { runId: "codex:thread-long:turn-long", session };
  }
}

class NormalizedCodexFixtureProvider implements ExecutorProvider {
  readonly id = "codex" as const;
  readonly capabilities = ["issue_execution"] as const;

  async run(input: ProviderRunInput) {
    const notifications = [
      { method: "turn/started", params: { threadId: "thread-normalized", turn: { id: "turn-normalized" } } },
      { method: "future/event", params: { threadId: "thread-normalized", turnId: "turn-normalized", opaque: true } },
      {
        method: "thread/tokenUsage/updated",
        params: {
          threadId: "thread-normalized",
          turnId: "turn-normalized",
          tokenUsage: {
            last: { cachedInputTokens: 1, inputTokens: 4, outputTokens: 2, reasoningOutputTokens: 1, totalTokens: 6 },
            total: { cachedInputTokens: 3, inputTokens: 12, outputTokens: 5, reasoningOutputTokens: 2, totalTokens: 17 }
          }
        }
      },
      { method: "turn/completed", params: { threadId: "thread-normalized", turn: { id: "turn-normalized", status: "completed" } } }
    ];
    notifications.forEach((notification) => input.onEvent?.(normalizeCodexEvent(notification)));
    return {
      runId: "codex:thread-normalized:turn-normalized",
      session: { provider: this.id, sessionId: "thread-normalized", turnId: "turn-normalized" }
    };
  }
}

class VerificationCodexFixtureProvider implements ExecutorProvider {
  readonly id = "codex" as const;
  readonly capabilities = ["issue_execution"] as const;

  async run(input: ProviderRunInput) {
    const threadId = "thread-verification";
    const turnId = "turn-verification";
    const itemId = "command-verification";
    const processId = "process-verification";
    const completedAtMs = Date.now();
    [
      { method: "turn/started", params: { threadId, turn: { id: turnId } } },
      {
        method: "item/commandExecution/terminalInteraction",
        params: { itemId, processId, stdin: "", threadId, turnId }
      },
      {
        method: "item/completed",
        params: {
          completedAtMs,
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
    ].forEach((notification) => input.onEvent?.(normalizeCodexEvent(notification)));
    return { runId: `codex:${threadId}:${turnId}`, session: { provider: this.id, sessionId: threadId, turnId } };
  }
}

class ThrowingProvider implements ExecutorProvider {
  readonly id = "codex" as const;
  readonly capabilities = ["issue_execution"] as const;

  async run(): Promise<never> {
    throw new Error("provider failed CODEX_API_KEY=fixture-secret");
  }
}

class SessionThenThrowProvider implements ExecutorProvider {
  readonly id = "pi-coding-agent" as const;
  readonly capabilities = ["issue_execution", "sessions"] as const;

  async run(input: ProviderRunInput): Promise<never> {
    const session = { provider: this.id, sessionId: "pi-durable-session" } as const;
    input.onEvent?.({ provider: this.id, session, status: "running", type: "provider.session_started" });
    input.onEvent?.({ provider: this.id, session, status: "failed", error: "idle timeout", type: "error" });
    throw new Error("idle timeout");
  }
}

async function openFixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "xuanwu-bun-provider-runtime-"));
  tempRoots.push(root);
  return openDatabase({ stateDir: join(root, "state") });
}

afterEach(async () => {
  while (tempRoots.length > 0) {
    const path = tempRoots.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

describe("executor provider runtime seam", () => {
  test("P10: Pi 已是 executor provider id（RPC adapter 注册后）", () => {
    expect(isExecutorProviderId("pi")).toBe(true);
  });

  test("runner layer can execute a fake provider and observe session refs/events", async () => {
    const provider = new FakeExecutionProvider();
    const events: ProviderEvent[] = [];

    const result = await runIssueWithProvider(provider, {
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

    expect(provider.lastInput).toMatchObject({ issueId: 154, projectId: "xuanwu", serviceTier: "priority" });
    expect(result).toEqual({
      runId: "fake-run",
      session: { provider: "fake-execution-only", sessionId: "fake-session", turnId: "fake-turn" }
    });
    expect(events).toEqual([{
      provider: "fake-execution-only",
      type: "provider.message",
      text: "fake provider log",
      session: result.session
    }]);
  });

  test("runtime hooks persist start, events, and final provider session refs", async () => {
    const provider = new FakeExecutionProvider();
    const calls: Array<[string, unknown]> = [];

    const result = await runIssueWithProvider(provider, {
      issueId: 159,
      projectId: "demo",
      cwd: "/tmp/project",
      prompt: "issue prompt",
      onRunStart: (input) => calls.push(["start", input]),
      onRuntimeEvent: (event) => calls.push(["event", event]),
      onRunComplete: (output) => calls.push(["complete", output])
    });

    expect(result.session).toEqual({ provider: "fake-execution-only", sessionId: "fake-session", turnId: "fake-turn" });
    expect(calls).toEqual([
      ["start", { provider: "fake-execution-only", issueId: 159, projectId: "demo", metadata: { cwd: "/tmp/project" } }],
      ["event", {
        provider: "fake-execution-only",
        type: "provider.message",
        text: "fake provider log",
        session: result.session
      }],
      ["complete", {
        provider: "fake-execution-only",
        issueId: 159,
        projectId: "demo",
        runId: "fake-run",
        session: result.session
      }]
    ]);
  });

  test("normalizes thrown provider failures when no wire error was emitted", async () => {
    const events: ProviderEvent[] = [];

    await expect(runIssueWithProvider(new ThrowingProvider(), {
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
    const db = await openFixtureDatabase();
    try {
      insertProject(db, "demo");
      const issueId = insertIssue(db, "demo");

      await expect(runIssueWithProvider(new SessionThenThrowProvider(), {
        database: db,
        issueId,
        projectId: "demo",
        cwd: "/tmp/project",
        prompt: "issue prompt"
      })).rejects.toThrow("idle timeout");

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
    } finally {
      db.close();
    }
  });

  test("persists provider session refs into issue_runs and agent_sessions", async () => {
    const db = await openFixtureDatabase();
    try {
      insertProject(db, "demo");
      const issueId = insertIssue(db, "demo");

      await runIssueWithProvider(new FakeExecutionProvider(), {
        database: db,
        issueId,
        projectId: "demo",
        cwd: "/tmp/project",
        prompt: "issue prompt",
        serviceTier: "priority",
        serviceTierSource: "issue"
      });

      expect(listIssueRuns(db, issueId)).toMatchObject([{
        attempt: 1,
        provider: "fake-execution-only",
        provider_session_id: "fake-session",
        provider_turn_id: "fake-turn",
        codex_thread_id: "",
        codex_turn_id: "",
        runtime_metadata_json: "{\"run_id\":\"fake-run\",\"service_tier\":\"priority\",\"service_tier_source\":\"issue\"}"
      }]);
      expect(getAgentSession(db, "fake-execution-only:fake-session")).toMatchObject({
        provider: "fake-execution-only",
        provider_session_id: "fake-session",
        project_id: "demo",
        issue_id: issueId,
        raw_ref: "{\"provider_turn_id\":\"fake-turn\",\"run_id\":\"fake-run\",\"service_tier\":\"priority\",\"service_tier_source\":\"issue\"}"
      });
      const issueEvents = listIssueEvents(db, issueId);
      expect(issueEvents).toMatchObject([{
        issue_id: issueId,
        type: "issue.log"
      }]);
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
    } finally {
      db.close();
    }
  });

  test("keeps completed PTY output as an artifact without synthesizing verification Evidence", async () => {
    const db = await openFixtureDatabase();
    try {
      insertProject(db, "demo");
      const issueId = insertIssue(db, "demo");

      await runIssueWithProvider(new VerificationCodexFixtureProvider(), {
        database: db,
        issueId,
        projectId: "demo",
        cwd: "/tmp/project",
        prompt: "run verification"
      });

      const records = listStoredEvidence(db, { issue_ids: [issueId], limit: 10 }).items;
      const completed = db.sqlite.query<{ payload: string }, [number]>(`
        select payload from issue_events where issue_id=? and type='issue.log'
          and json_extract(payload, '$.raw_method')='item/completed' limit 1
      `).get(issueId);
      expect(records).toHaveLength(0);
      expect(JSON.parse(completed?.payload ?? "{}")).toMatchObject({
        issue_log_artifact: { schema_version: "issue-log-payload-artifact.v1" }
      });
    } finally {
      db.close();
    }
  });

  test("persists normalized provider evidence and projects audited usage without acting on unknown events", async () => {
    const db = await openFixtureDatabase();
    try {
      insertProject(db, "demo");
      const issueId = insertIssue(db, "demo");

      await runIssueWithProvider(new NormalizedCodexFixtureProvider(), {
        database: db,
        issueId,
        projectId: "demo",
        cwd: "/tmp/project",
        prompt: "normalized fixture"
      });

      const events = listIssueEvents(db, issueId);
      const payloads = events.map((event) => ({
        event,
        payload: JSON.parse(event.payload) as Record<string, unknown>
      }));
      const unknown = payloads.find(({ payload }) => payload.raw_method === "future/event");
      const usage = payloads.find(({ payload }) => payload.raw_method === "thread/tokenUsage/updated");
      const attempt = db.sqlite.query<{ cost_json: string; revision: number; status: string }, [number]>(`
        select attempt.cost_json, attempt.revision, attempt.status
        from run_attempts attempt
        join issue_runs run on run.id=attempt.issue_run_id
        where run.issue_id=?
      `).get(issueId);
      const cost = JSON.parse(attempt?.cost_json ?? "{}") as Record<string, unknown>;

      expect(unknown?.payload.run_event).toMatchObject({
        kind: "unknown",
        outcome: "unknown",
        terminal: false,
        unknown: { policy: "preserve" }
      });
      expect(attempt?.status).toBe("succeeded");
      expect(attempt?.revision).toBe(1);
      expect(cost).toMatchObject({
        money: { amount_micros: null, basis: "unavailable", currency: "" },
        usage: {
          cached_input_tokens: 3,
          completeness: "complete",
          input_tokens: 12,
          output_tokens: 5,
          reasoning_output_tokens: 2,
          total_tokens: 17
        }
      });
      expect((cost.source_refs as string[])).toEqual(expect.arrayContaining([
        "provider-event:codex:thread/tokenUsage/updated:thread-normalized:turn-normalized",
        `issue_events:${usage?.event.id}`
      ]));
    } finally {
      db.close();
    }
  });

  test("persists Codex thread idle status without raw telemetry flipping it back to running", async () => {
    const db = await openFixtureDatabase();
    try {
      insertProject(db, "demo");
      const issueId = insertIssue(db, "demo");

      await runIssueWithProvider(new IdleStatusProvider(), {
        database: db,
        issueId,
        projectId: "demo",
        cwd: "/tmp/project",
        prompt: "issue prompt"
      });

      expect(getAgentSession(db, "codex:thread-idle")).toMatchObject({
        issue_id: issueId,
        provider: "codex",
        provider_session_id: "thread-idle",
        status: "idle"
      });
      expect(listIssueRuns(db, issueId)).toMatchObject([{
        provider: "codex",
        provider_session_id: "thread-idle",
        provider_turn_id: "turn-idle"
      }]);
    } finally {
      db.close();
    }
  });

  test("keeps a Claude run separate from stale Codex thread fields when status is closed during execution", async () => {
    const db = await openFixtureDatabase();
    try {
      insertProject(db, "demo");
      const issueId = insertIssue(db, "demo");
      const codexRun = createIssueRun(db, issueId);
      updateIssueRuntime(db, issueId, {
        provider: "codex",
        provider_session_id: "codex-thread",
        provider_turn_id: "codex-turn",
        metadata: { run_id: "codex-run" }
      });
      closeRun(db, codexRun.id);

      await runIssueWithProvider(new ClosingClaudeProvider(db), {
        database: db,
        issueId,
        projectId: "demo",
        cwd: "/tmp/project",
        prompt: "issue prompt"
      });

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
          runtime_metadata_json: "{\"run_id\":\"claude-run\"}"
        }
      ]);
      expect(getAgentSession(db, "claude:claude-session")).toMatchObject({
        provider: "claude",
        provider_session_id: "claude-session",
        issue_id: issueId,
        raw_ref: "{\"provider_turn_id\":\"claude-turn\",\"run_id\":\"claude-run\"}"
      });
    } finally {
      db.close();
    }
  });

  test("normal mode keeps live hooks and terminal state without persisting stream deltas", async () => {
    const db = await openFixtureDatabase();
    try {
      insertProject(db, "demo");
      const issueId = insertIssue(db, "demo", "normal");
      const provider = new LongSessionProvider();
      const runtimeEvents: ProviderEvent[] = [];
      const liveEvents: unknown[] = [];

      await runIssueWithProvider(provider, {
        database: db,
        issueId,
        projectId: "demo",
        cwd: "/tmp/project",
        prompt: "normal logs",
        bus: { publish: (event) => liveEvents.push(event) },
        onRuntimeEvent: (event) => runtimeEvents.push(event)
      });

      const events = listIssueEvents(db, issueId);
      const logEvents = events.filter((event) => event.type === "issue.log");
      expect(runtimeEvents).toHaveLength(514);
      expect(logEvents).toHaveLength(1);
      expect(JSON.parse(logEvents[0]?.payload ?? "{}")).toMatchObject({
        raw_method: "turn/completed",
        status: "completed"
      });
      expect(liveEvents.filter((event) => (event as { type?: string }).type === "issue.log")).toHaveLength(1);
      const session = getAgentSession(db, "codex:thread-long");
      expect(session).toMatchObject({ status: "completed" });
      expect(JSON.parse(session?.raw_ref ?? "{}")).toMatchObject({ provider_turn_id: "turn-long" });
    } finally {
      db.close();
    }
  });

  test("replays a long Session from aggregated logs with fewer rows and bytes", async () => {
    const db = await openFixtureDatabase();
    try {
      insertProject(db, "demo");
      const issueId = insertIssue(db, "demo");
      const provider = new LongSessionProvider();
      const runtimeEvents: ProviderEvent[] = [];
      const liveEvents: unknown[] = [];

      await runIssueWithProvider(provider, {
        database: db,
        issueId,
        projectId: "demo",
        cwd: "/tmp/project",
        prompt: "long session",
        bus: { publish: (event) => liveEvents.push(event) },
        onRuntimeEvent: (event) => runtimeEvents.push(event)
      });

      const events = listIssueEvents(db, issueId);
      const logEvents = events.filter((event) => event.type === "issue.log");
      const payloads = logEvents.map((event) => JSON.parse(event.payload) as Record<string, unknown>);
      const replay = payloads
        .filter((payload) => payload.raw_method === "item/agentMessage/delta")
        .map((payload) => payload.text)
        .join("");
      const storedBytes = db.sqlite.query<{ bytes: number }, [number]>(`
        select sum(length(cast(payload as blob))) as bytes from issue_events where issue_id=? and type='issue.log'
      `).get(issueId)?.bytes ?? 0;
      const baselineBytes = provider.chunks.reduce((total, text) => total + Buffer.byteLength(JSON.stringify({
        type: "text",
        provider: "codex",
        raw_method: "item/agentMessage/delta",
        raw_payload: JSON.stringify({ delta: text }),
        text
      })), 0);

      expect(runtimeEvents).toHaveLength(514);
      expect(logEvents).toHaveLength(10);
      expect(liveEvents.filter((event) => (event as { type?: string }).type === "issue.log")).toHaveLength(10);
      expect(replay).toBe(provider.chunks.join(""));
      expect(payloads.at(-1)).toMatchObject({
        type: "done",
        raw_method: "turn/completed",
        status: "completed"
      });
      expect(getIssue(db, issueId)?.issue_log_mode).toBe("normal");
      expect(storedBytes).toBeLessThan(baselineBytes * 0.35);
    } finally {
      db.close();
    }
  });

  test("P1: execution-only Provider 完成 Attempt 不写 Session", async () => {
    const db = await openFixtureDatabase();
    try {
      insertProject(db, "demo");
      const issueId = insertIssue(db, "demo");
      const provider = new ExecutionOnlyRuntimeProvider();
      const events: ProviderEvent[] = [];

      const result = await runIssueWithProvider(provider, {
        database: db,
        issueId,
        projectId: "demo",
        cwd: "/tmp/p1-execution-only",
        prompt: "execute",
        onLog: (event) => events.push(event)
      });

      expect(result.session).toBeUndefined();
      expect(events.some((event) => event.session !== undefined)).toBe(false);
      expect(listIssueRuns(db, issueId).at(-1)?.provider_session_id ?? "").toBe("");
    } finally {
      db.close();
    }
  });
});

function insertProject(db: RunnerDatabase, id: string): void {
  db.sqlite.run(
    `insert into projects (id, name, cwd, created_at, updated_at) values (?, ?, ?, ?, ?)`,
    [id, id, `/tmp/${id}`, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
}

function insertIssue(
  db: RunnerDatabase,
  projectId: string,
  issueLogMode: "debug" | "normal" = "debug"
): number {
  db.sqlite.run(
    `insert into issues (project_id, title, status, issue_log_mode, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?)`,
    [projectId, "Runtime", "in_progress", issueLogMode, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
  const row = db.sqlite.query<{ id: number }, []>("select last_insert_rowid() as id").get();
  if (!row) throw new Error("missing inserted issue id");
  return row.id;
}

function closeRun(db: RunnerDatabase, id: string): void {
  db.sqlite.run("update issue_runs set ended_at=?, status=? where id=?", ["2026-01-01T00:00:00Z", "done", id]);
}

class ExecutionOnlyRuntimeProvider implements ExecutorProvider {
  readonly id = "fake-execution-only" as const;
  readonly capabilities = ["issue_execution"] as const;

  async run(input: ProviderRunInput) {
    input.onEvent?.({
      provider: this.id,
      type: "provider.message",
      text: "execution only"
    });
    return { runId: `p1-execution-${input.issueId}` };
  }
}
