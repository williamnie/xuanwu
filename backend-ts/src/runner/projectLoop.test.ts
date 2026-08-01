import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { getAgentSession } from "../db/repositories/agentSessions.ts";
import { getIssue, listIssueRuns } from "../db/repositories/issues.ts";
import { recordIssueEvent } from "../db/repositories/issueEvents.ts";
import { listNotifications } from "../db/repositories/notifications.ts";
import { listPiGuardianAlerts } from "../db/repositories/pi.ts";
import { updateIssue } from "../db/repositories/issueUpdate.ts";
import { projectLoopDecision, runProjectLoopOnce } from "./projectLoop.ts";
import { isProjectLoopActive, kickAutoRunProjects, setProjectLoopMaxParallelProjects, startProjectLoop } from "./projectLoopManager.ts";
import type { ExecutorProvider, ExecutorProviderId, ProviderRunInput, ProviderRunResult } from "../providers/types.ts";

const tempRoots: string[] = [];

class FakeExecutionProvider implements ExecutorProvider {
  readonly id = "fake-execution-only" as const;
  readonly capabilities = ["issue_execution"] as const;
  readonly inputs: ProviderRunInput[] = [];

  async run(input: ProviderRunInput): Promise<ProviderRunResult> {
    this.inputs.push(input);
    input.onEvent?.({
      provider: this.id,
      type: "provider.message",
      text: "fake started",
      session: { provider: this.id, sessionId: `fake-session-${input.issueId}`, turnId: `fake-turn-${input.issueId}` }
    });
    return {
      runId: `fake-run-${input.issueId}`,
      session: { provider: this.id, sessionId: `fake-session-${input.issueId}`, turnId: `fake-turn-${input.issueId}` }
    };
  }
}

class FailingExecutionProvider extends FakeExecutionProvider {
  async run(input: ProviderRunInput): Promise<ProviderRunResult> {
    this.inputs.push(input);
    throw new Error("provider failed CODEX_API_KEY=fixture-secret");
  }
}

class NeedsUserExecutionProvider extends FakeExecutionProvider {
  async run(input: ProviderRunInput): Promise<ProviderRunResult> {
    this.inputs.push(input);
    input.onEvent?.({
      provider: this.id,
      type: "provider.message",
      text: "已完成环境检查。\nRUNNER_OUTCOME: needs_user | 缺少部署凭证",
      session: { provider: this.id, sessionId: `fake-session-${input.issueId}`, turnId: `fake-turn-${input.issueId}` }
    });
    return {
      runId: `fake-run-${input.issueId}`,
      session: { provider: this.id, sessionId: `fake-session-${input.issueId}`, turnId: `fake-turn-${input.issueId}` }
    };
  }
}

class CompletedExecutionProvider extends FakeExecutionProvider {
  async run(input: ProviderRunInput): Promise<ProviderRunResult> {
    const result = await super.run(input);
    input.onEvent?.({
      provider: this.id,
      raw: { method: "turn/completed" },
      status: "completed",
      type: "done",
      session: result.session
    });
    return result;
  }
}

class DeferredCompletionProvider extends FakeExecutionProvider {
  private readonly completions = new Map<number, () => void>();

  async run(input: ProviderRunInput): Promise<ProviderRunResult> {
    this.inputs.push(input);
    const session = {
      provider: this.id,
      sessionId: `fake-session-${input.issueId}`,
      turnId: `fake-turn-${input.issueId}`
    };
    input.onEvent?.({
      provider: this.id,
      status: "running",
      type: "turn_started",
      session
    });
    this.completions.set(input.issueId, () => input.onEvent?.({
      provider: this.id,
      raw: { method: "turn/completed" },
      status: "completed",
      type: "done",
      session
    }));
    return { runId: `fake-run-${input.issueId}`, session };
  }

  complete(issueID: number): void {
    const completion = this.completions.get(issueID);
    if (!completion) throw new Error(`missing deferred completion for issue ${issueID}`);
    this.completions.delete(issueID);
    completion();
  }
}

class MessageFailingExecutionProvider extends FakeExecutionProvider {
  constructor(private readonly message: string) {
    super();
  }

  async run(input: ProviderRunInput): Promise<ProviderRunResult> {
    this.inputs.push(input);
    throw new Error(this.message);
  }
}

class TransientInfraExecutionProvider implements ExecutorProvider {
  readonly id = "claude" as const;
  readonly capabilities = ["issue_execution"] as const;
  readonly inputs: ProviderRunInput[] = [];

  async run(input: ProviderRunInput): Promise<ProviderRunResult> {
    this.inputs.push(input);
    throw new Error("codex app-server request timed out after 10000ms: initialize");
  }
}

class NamedExecutionProvider implements ExecutorProvider {
  readonly capabilities = ["issue_execution"] as const;
  readonly inputs: ProviderRunInput[] = [];

  constructor(readonly id: "codex" | "claude") {}

  async run(input: ProviderRunInput): Promise<ProviderRunResult> {
    this.inputs.push(input);
    const sessionId = `${this.id}-session-${input.issueId}`;
    const turnId = `${this.id}-turn-${input.issueId}`;
    input.onEvent?.({
      provider: this.id,
      session: { provider: this.id, sessionId, turnId },
      status: "running",
      type: "turn_started"
    });
    return { runId: `${this.id}-run-${input.issueId}`, session: { provider: this.id, sessionId, turnId } };
  }
}

class TerminalExecutionProvider extends FakeExecutionProvider {
  constructor(
    private readonly db: RunnerDatabase,
    private readonly status: "failed" | "pending_verification"
  ) {
    super();
  }

  async run(input: ProviderRunInput): Promise<ProviderRunResult> {
    const result = await super.run(input);
    updateIssue(this.db, input.issueId, {
      error: this.status === "failed" ? "executor reported a scoped failure" : "verification evidence required",
      status: this.status
    });
    return result;
  }
}

async function openFixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-bun-project-loop-"));
  tempRoots.push(root);
  return openDatabase({ stateDir: join(root, "state") });
}

afterEach(async () => {
  setProjectLoopMaxParallelProjects(1);
  while (tempRoots.length > 0) {
    const path = tempRoots.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

describe("Bun project loop claim execution", () => {
  test("claims a single todo issue by runner order and starts provider run", async () => {
    const db = await openFixtureDatabase();
    const provider = new FakeExecutionProvider();
    try {
      insertProject(db, { id: "demo", provider: provider.id });
      const laterHigh = insertIssue(db, { projectId: "demo", title: "later high", priority: 5, createdAt: "2026-01-03T00:00:00Z" });
      const firstHigh = insertIssue(db, { projectId: "demo", title: "first high", priority: 5, createdAt: "2026-01-02T00:00:00Z" });
      const low = insertIssue(db, { projectId: "demo", title: "low", priority: 1, createdAt: "2026-01-01T00:00:00Z" });

      const result = await runProjectLoopOnce({ database: db, projectId: "demo", providers: { [provider.id]: provider } });

      expect(result.claimed).toBe(true);
      if (!result.claimed) throw new Error("expected claim");
      expect(result.issue.id).toBe(firstHigh);
      expect(provider.inputs).toHaveLength(1);
      expect(provider.inputs[0]).toMatchObject({ issueId: firstHigh, projectId: "demo" });
      expect(provider.inputs[0]?.prompt).toContain("first high");
      expect(getIssue(db, firstHigh)).toMatchObject({ status: "in_progress", attempt_count: 1 });
      expect(getIssue(db, laterHigh)).toMatchObject({ status: "todo" });
      expect(getIssue(db, low)).toMatchObject({ status: "todo" });
      expect(listIssueRuns(db, firstHigh)).toMatchObject([{
        attempt: 1,
        status: "in_progress",
        provider: "fake-execution-only",
        provider_session_id: `fake-session-${firstHigh}`,
        provider_turn_id: `fake-turn-${firstHigh}`,
        runtime_metadata_json: `{"run_id":"fake-run-${firstHigh}"}`,
        ended_at: ""
      }]);
      expect(getAgentSession(db, `fake-execution-only:fake-session-${firstHigh}`)).toMatchObject({
        provider: "fake-execution-only",
        provider_session_id: `fake-session-${firstHigh}`,
        issue_id: firstHigh,
        status: "running"
      });
    } finally {
      db.close();
    }
  });

  test("injects a minimal goal contract into default issue prompts", async () => {
    const db = await openFixtureDatabase();
    const provider = new FakeExecutionProvider();
    try {
      insertProject(db, { id: "demo", provider: provider.id });
      insertIssue(db, {
        description: "Add the focused runner prompt guidance.",
        projectId: "demo",
        title: "prompt contract"
      });

      await runProjectLoopOnce({ database: db, projectId: "demo", providers: { [provider.id]: provider } });

      const prompt = provider.inputs[0]?.prompt ?? "";
      expect(prompt).toContain("Add the focused runner prompt guidance.");
      expect(prompt).toContain("## Goal Contract");
      expect(prompt).toContain("- Target outcome:");
      expect(prompt).toContain("- Required evidence:");
      expect(prompt).toContain("run the smallest directly relevant verification");
      expect(prompt).toContain("report the final outcome with the Runner lifecycle marker");
      expect(prompt).toContain("- Constraints / non-goals:");
      expect(prompt).toContain("- Stop policy / escalation:");
      expect(prompt).toContain("same failure repeats");
      expect(prompt).toContain("schema/public-contract/shared-runtime changes");
      expect(prompt).toContain("Never run ./redeploy.sh");
      expect(prompt).toContain("do not bypass this boundary with nohup, launchctl submit");
      expect(prompt).toContain("external post-completion delivery action");
      expect(prompt).toContain("./dev.sh with isolated non-live state and ports");
      expect(prompt).toContain("Live deployment must be performed externally");
    } finally {
      db.close();
    }
  });

  test("injects the latest governed Supervisor retry resolution into the new attempt prompt", async () => {
    const db = await openFixtureDatabase();
    const provider = new FakeExecutionProvider();
    try {
      insertProject(db, { id: "demo", provider: provider.id });
      const issueID = insertIssue(db, {
        description: "Implement the batch upload handler without unrelated changes.",
        projectId: "demo",
        title: "batch upload"
      });
      recordIssueEvent(db, issueID, "issue.supervisor_retry", {
        decision_id: "decision-batch-contract",
        reason: "The user explicitly authorized a backward-compatible public API contract extension for batch upload."
      });

      await runProjectLoopOnce({ database: db, projectId: "demo", providers: { [provider.id]: provider } });

      const prompt = provider.inputs[0]?.prompt ?? "";
      expect(prompt).toContain("## Governed retry context");
      expect(prompt).toContain("Decision: decision-batch-contract");
      expect(prompt).toContain("explicitly authorized a backward-compatible public API contract extension");
      expect(prompt.indexOf("## Governed retry context")).toBeGreaterThan(prompt.indexOf("## Goal Contract"));
    } finally {
      db.close();
    }
  });

  test("does not duplicate existing goal contract headings", async () => {
    const db = await openFixtureDatabase();
    const provider = new FakeExecutionProvider();
    try {
      insertProject(db, { id: "demo", provider: provider.id });
      insertIssue(db, {
        description: [
          "## Target outcome",
          "Keep the existing target text.",
          "## Required evidence",
          "Use the issue-specific verification.",
          "## Constraints / non-goals",
          "Stay inside this issue.",
          "## Stop policy / escalation",
          "Report blockers."
        ].join("\n"),
        projectId: "demo",
        title: "custom contract"
      });

      await runProjectLoopOnce({ database: db, projectId: "demo", providers: { [provider.id]: provider } });

      const prompt = provider.inputs[0]?.prompt ?? "";
      expect(prompt).toContain("## Target outcome");
      expect(prompt).not.toContain("## Goal Contract");
      expect(prompt).not.toContain("Deliver the requested end state");
      expect(prompt).toContain("## Runner lifecycle contract");
      expect(prompt).toContain("RUNNER_OUTCOME: completed");
      expect(prompt).not.toContain("issue update --id");
    } finally {
      db.close();
    }
  });

  test("idles safely when there are no todo issues", async () => {
    const db = await openFixtureDatabase();
    const provider = new FakeExecutionProvider();
    try {
      insertProject(db, { id: "demo", provider: provider.id });
      insertIssue(db, { projectId: "demo", title: "triage", status: "triage" });

      const result = await runProjectLoopOnce({ database: db, projectId: "demo", providers: { [provider.id]: provider } });

      expect(result).toEqual({ claimed: false });
      expect(provider.inputs).toEqual([]);
    } finally {
      db.close();
    }
  });

  test("does not claim another todo for the same project while an executor run is still open", async () => {
    const db = await openFixtureDatabase();
    const provider = new FakeExecutionProvider();
    try {
      insertProject(db, { id: "demo", provider: provider.id });
      const running = insertIssue(db, { projectId: "demo", title: "running", status: "in_progress" });
      const waiting = insertIssue(db, { projectId: "demo", title: "waiting" });
      insertOpenRun(db, running);

      const result = await runProjectLoopOnce({ database: db, projectId: "demo", providers: { [provider.id]: provider } });

      expect(result).toEqual({ claimed: false });
      expect(provider.inputs).toEqual([]);
      expect(getIssue(db, waiting)).toMatchObject({ status: "todo", attempt_count: 0 });
      expect(listIssueRuns(db, waiting)).toEqual([]);
    } finally {
      db.close();
    }
  });

  test("claims a different project while an unrelated project run is open", async () => {
    const db = await openFixtureDatabase();
    const provider = new FakeExecutionProvider();
    try {
      insertProject(db, { id: "demo", provider: provider.id });
      insertProject(db, { id: "other", provider: provider.id });
      const running = insertIssue(db, { projectId: "demo", title: "running", status: "in_progress" });
      const waiting = insertIssue(db, { projectId: "other", title: "waiting" });
      insertOpenRun(db, running);

      const result = await runProjectLoopOnce({ database: db, projectId: "other", providers: { [provider.id]: provider } });

      expect(result).toMatchObject({ claimed: true });
      expect(provider.inputs.map((input) => input.issueId)).toEqual([waiting]);
      expect(getIssue(db, waiting)).toMatchObject({ status: "in_progress", attempt_count: 1 });
    } finally {
      db.close();
    }
  });

  test("auto-run loop starts one session and leaves remaining todos queued", async () => {
    const db = await openFixtureDatabase();
    const provider = new FakeExecutionProvider();
    try {
      insertProject(db, { id: "serial-demo", provider: provider.id, autoRun: 1 });
      const first = insertIssue(db, { projectId: "serial-demo", title: "first" });
      const second = insertIssue(db, { projectId: "serial-demo", title: "second" });

      startProjectLoop({ database: db, providers: { [provider.id]: provider } }, "serial-demo");
      await waitFor(() => provider.inputs.length === 1);
      await waitFor(() => !isProjectLoopActive("serial-demo"));

      expect(provider.inputs.map((input) => input.issueId)).toEqual([first]);
      expect(getIssue(db, first)).toMatchObject({ status: "in_progress", attempt_count: 1 });
      expect(getIssue(db, second)).toMatchObject({ status: "todo", attempt_count: 0 });
      expect(listIssueRuns(db, second)).toEqual([]);
    } finally {
      db.close();
    }
  });

  test("an asynchronous terminal event releases the slot and starts the next queued issue", async () => {
    const db = await openFixtureDatabase();
    const provider = new DeferredCompletionProvider();
    try {
      insertProject(db, { id: "deferred-demo", provider: provider.id, autoRun: 1 });
      const first = insertIssue(db, { projectId: "deferred-demo", title: "first" });
      const second = insertIssue(db, { projectId: "deferred-demo", title: "second" });

      startProjectLoop({ database: db, providers: { [provider.id]: provider } }, "deferred-demo");
      await waitFor(() => provider.inputs.length === 1);
      await waitFor(() => !isProjectLoopActive("deferred-demo"));

      provider.complete(first);
      await waitFor(() => provider.inputs.length === 2);
      await waitFor(() => !isProjectLoopActive("deferred-demo"));

      expect(provider.inputs.map((input) => input.issueId)).toEqual([first, second]);
      expect(getIssue(db, first)).toMatchObject({ status: "pending_verification" });
      expect(getIssue(db, second)).toMatchObject({ status: "in_progress" });
    } finally {
      db.close();
    }
  });

  test("auto-run can start different projects up to the global concurrency limit", async () => {
    const db = await openFixtureDatabase();
    const provider = new FakeExecutionProvider();
    try {
      setProjectLoopMaxParallelProjects(2);
      insertProject(db, { id: "project-a", provider: provider.id, autoRun: 1 });
      insertProject(db, { id: "project-b", provider: provider.id, autoRun: 1 });
      const first = insertIssue(db, { projectId: "project-a", title: "first" });
      const second = insertIssue(db, { projectId: "project-b", title: "second" });

      startProjectLoop({ database: db, providers: { [provider.id]: provider } }, "project-a");
      startProjectLoop({ database: db, providers: { [provider.id]: provider } }, "project-b");
      await waitFor(() => provider.inputs.length === 2);
      await waitFor(() => !isProjectLoopActive("project-a") && !isProjectLoopActive("project-b"));

      expect(provider.inputs.map((input) => input.issueId).sort((a, b) => a - b)).toEqual([first, second]);
      expect(getIssue(db, first)).toMatchObject({ status: "in_progress", attempt_count: 1 });
      expect(getIssue(db, second)).toMatchObject({ status: "in_progress", attempt_count: 1 });
    } finally {
      db.close();
    }
  });

  test("explicit project hold blocks auto-run and forced execution without creating a Run", async () => {
    const db = await openFixtureDatabase();
    const provider = new FakeExecutionProvider();
    try {
      insertProject(db, { id: "held", provider: provider.id, autoRun: 1 });
      const issueID = insertIssue(db, { projectId: "held", title: "held issue" });
      db.sqlite.run(`insert into project_holds
        (project_id, reason, message, hold_since, updated_at) values (?, ?, ?, ?, ?)`, [
        "held", "user_pause", "explicit fixture hold", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"
      ]);

      startProjectLoop({ database: db, providers: { [provider.id]: provider } }, "held", { forceOnce: true });
      await waitFor(() => !isProjectLoopActive("held"));

      expect(provider.inputs).toEqual([]);
      expect(getIssue(db, issueID)).toMatchObject({ status: "todo", attempt_count: 0 });
      expect(listIssueRuns(db, issueID)).toEqual([]);
      expect(latestEventPayload(db, issueID, "issue.runner_scope_decision")).toMatchObject({
        authority: "project_holds",
        decision: "stop",
        reason: "project_hold",
        scope: "project:held"
      });
    } finally {
      db.close();
    }
  });

  test("provider runtime blocker stays provider-scoped while another provider keeps running", async () => {
    const db = await openFixtureDatabase();
    const healthy = new FakeExecutionProvider();
    try {
      insertProject(db, { id: "missing-codex", provider: "codex", autoRun: 1 });
      insertProject(db, { id: "healthy", provider: healthy.id, autoRun: 1 });
      const blocked = insertIssue(db, { projectId: "missing-codex", title: "provider blocked" });
      const runnable = insertIssue(db, { projectId: "healthy", title: "provider ready" });
      const runtime = { database: db, providers: { [healthy.id]: healthy } };

      startProjectLoop(runtime, "missing-codex");
      startProjectLoop(runtime, "healthy");
      await waitFor(() => healthy.inputs.length === 1);
      await waitFor(() => !isProjectLoopActive("missing-codex") && !isProjectLoopActive("healthy"));

      expect(healthy.inputs.map((input) => input.issueId)).toEqual([runnable]);
      expect(getIssue(db, blocked)).toMatchObject({ status: "todo", attempt_count: 0 });
      expect(listIssueRuns(db, blocked)).toEqual([]);
      expect(latestEventPayload(db, blocked, "issue.runner_scope_decision")).toMatchObject({
        authority: "runner.providers",
        decision: "stop",
        provider: "codex",
        reason: "provider_runtime",
        scope: "provider:codex"
      });
    } finally {
      db.close();
    }
  });

  test("persisted provider deferral blocks the same provider but releases global capacity", async () => {
    const db = await openFixtureDatabase();
    const outage = new TransientInfraExecutionProvider();
    const healthy = new FakeExecutionProvider();
    try {
      insertProject(db, { id: "outage", provider: outage.id, autoRun: 1 });
      insertProject(db, { id: "same-provider", provider: outage.id, autoRun: 1 });
      insertProject(db, { id: "other-provider", provider: healthy.id, autoRun: 1 });
      const deferred = insertIssue(db, { projectId: "outage", title: "deferred" });
      const providerBlocked = insertIssue(db, { projectId: "same-provider", title: "same provider" });
      const runnable = insertIssue(db, { projectId: "other-provider", title: "other provider" });
      const runtime = { database: db, providers: { [outage.id]: outage, [healthy.id]: healthy } };

      startProjectLoop(runtime, "outage");
      await waitFor(() => listEventTypes(db, deferred).includes("issue.provider_deferred"));
      await waitFor(() => healthy.inputs.length === 1);

      expect(healthy.inputs.map((input) => input.issueId)).toEqual([runnable]);
      expect(getIssue(db, providerBlocked)).toMatchObject({ status: "todo", attempt_count: 0 });
      expect(listIssueRuns(db, providerBlocked)).toEqual([]);
      expect(projectLoopDecision({ ...runtime, projectId: "same-provider" }, false)).toMatchObject({
        allowed: false,
        authority: "issue.provider_deferred",
        provider: "claude",
        reason: "provider_runtime",
        scope: "provider:claude"
      });
    } finally {
      db.close();
    }
  });

  test("rekicks an already queued project after global executor capacity is released", async () => {
    const db = await openFixtureDatabase();
    const provider = new FakeExecutionProvider();
    try {
      insertProject(db, { id: "busy", provider: provider.id, autoRun: 1 });
      insertProject(db, { id: "waiting", provider: provider.id, autoRun: 1 });
      const busy = insertIssue(db, { projectId: "busy", title: "busy", status: "in_progress" });
      const waiting = insertIssue(db, { projectId: "waiting", title: "waiting" });
      insertOpenRun(db, busy);

      startProjectLoop({ database: db, providers: { [provider.id]: provider } }, "waiting");
      await Bun.sleep(20);
      expect(provider.inputs).toHaveLength(0);
      expect(isProjectLoopActive("waiting")).toBe(true);
      expect(getIssue(db, waiting)).toMatchObject({ status: "todo", attempt_count: 0 });

      closeClaimedIssue(db, busy);
      startProjectLoop({ database: db, providers: { [provider.id]: provider } }, "waiting");
      await waitFor(() => provider.inputs.length === 1);
      await waitFor(() => !isProjectLoopActive("waiting"));

      expect(provider.inputs.map((input) => input.issueId)).toEqual([waiting]);
      expect(getIssue(db, waiting)).toMatchObject({ status: "in_progress", attempt_count: 1 });
    } finally {
      db.close();
    }
  });

  test("provider startup failure does not block an independent ready sibling", async () => {
    const db = await openFixtureDatabase();
    const provider = new FailingExecutionProvider();
    try {
      insertProject(db, { id: "failure-demo", provider: provider.id, autoRun: 1 });
      const first = insertIssue(db, { projectId: "failure-demo", title: "first" });
      const second = insertIssue(db, { projectId: "failure-demo", title: "second" });

      startProjectLoop({ database: db, providers: { [provider.id]: provider } }, "failure-demo");
      await waitFor(() => getIssue(db, first)?.status === "failed");
      await waitFor(() => !isProjectLoopActive("failure-demo"));

      expect(provider.inputs.map((input) => input.issueId)).toEqual([first, second]);
      expect(getIssue(db, first)).toMatchObject({ status: "failed", attempt_count: 1 });
      expect(getIssue(db, second)).toMatchObject({ status: "failed", attempt_count: 1 });
      expect(listIssueRuns(db, second)).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  for (const status of ["failed"] as const) {
    test(`executor ${status} does not act as a project-wide fuse for ready siblings`, async () => {
      const db = await openFixtureDatabase();
      const provider = new TerminalExecutionProvider(db, status);
      try {
        insertProject(db, { id: `terminal-${status}`, provider: provider.id, autoRun: 1 });
        const first = insertIssue(db, { projectId: `terminal-${status}`, title: "first" });
        const second = insertIssue(db, { projectId: `terminal-${status}`, title: "second" });

        startProjectLoop({ database: db, providers: { [provider.id]: provider } }, `terminal-${status}`);
        await waitFor(() => getIssue(db, first)?.status === status);
        await waitFor(() => !isProjectLoopActive(`terminal-${status}`));

        kickAutoRunProjects({ database: db, providers: { [provider.id]: provider } });
        await Bun.sleep(20);

        expect(provider.inputs.map((input) => input.issueId)).toEqual([first, second]);
        expect(getIssue(db, second)).toMatchObject({ status, attempt_count: 1 });
        expect(listIssueRuns(db, second)).toHaveLength(1);
      } finally {
        db.close();
      }
    });
  }

  test("auto-run defers provider startup failures without leaving a phantom in-progress Run", async () => {
    const db = await openFixtureDatabase();
    const provider = new TransientInfraExecutionProvider();
    try {
      insertProject(db, { id: "infra-demo", provider: provider.id, autoRun: 1 });
      const first = insertIssue(db, { projectId: "infra-demo", title: "first" });
      const second = insertIssue(db, { projectId: "infra-demo", title: "second" });

      startProjectLoop({ database: db, providers: { [provider.id]: provider } }, "infra-demo");
      await waitFor(() => listEventTypes(db, first).includes("issue.provider_deferred"));
      await waitFor(() => !isProjectLoopActive("infra-demo"));

      expect(provider.inputs.map((input) => input.issueId)).toEqual([first]);
      expect(getIssue(db, first)).toMatchObject({
        status: "todo",
        auto_retry_reason: `provider_infra_transient:${provider.id}`,
        auto_retry_next_at: expect.stringMatching(/Z$/),
        error: "codex app-server request timed out after 10000ms: initialize"
      });
      expect(listIssueRuns(db, first).at(-1)).toMatchObject({
        provider: "claude",
        status: "failed",
        ended_at: expect.stringMatching(/Z$/),
        exit_reason: "provider_deferred",
        error: "codex app-server request timed out after 10000ms: initialize"
      });
      expect(getIssue(db, second)).toMatchObject({ status: "todo", attempt_count: 0 });
      expect(listIssueRuns(db, second)).toEqual([]);
      expect(listEventTypes(db, first)).toContain("issue.provider_deferred");
    } finally {
      db.close();
    }
  });

  test("keeps auth and quota failures terminal even when wrapped in transport wording", async () => {
    for (const [index, message] of [
      "transport error: 401 unauthorized",
      "network error: insufficient quota"
    ].entries()) {
      const db = await openFixtureDatabase();
      const provider = new MessageFailingExecutionProvider(message);
      try {
        insertProject(db, { id: `terminal-demo-${index}`, provider: provider.id });
        const issueId = insertIssue(db, { projectId: `terminal-demo-${index}`, title: "terminal provider failure" });

        await runProjectLoopOnce({ database: db, projectId: `terminal-demo-${index}`, providers: { [provider.id]: provider } });

        expect(getIssue(db, issueId)).toMatchObject({ status: "failed", error: message });
        expect(listIssueRuns(db, issueId).at(-1)).toMatchObject({ status: "failed", exit_reason: "failed" });
        expect(listEventTypes(db, issueId)).not.toContain("issue.provider_deferred");
      } finally {
        db.close();
      }
    }
  });

  test("forced loop starts one executor session even when project auto-run is off", async () => {
    const db = await openFixtureDatabase();
    const provider = new FakeExecutionProvider();
    try {
      insertProject(db, { id: "manual-demo", provider: provider.id });
      const issueId = insertIssue(db, { projectId: "manual-demo", title: "from IM" });

      startProjectLoop({ database: db, providers: { [provider.id]: provider } }, "manual-demo", { forceOnce: true });
      await waitFor(() => provider.inputs.length === 1);
      await waitFor(() => !isProjectLoopActive("manual-demo"));

      expect(provider.inputs.map((input) => input.issueId)).toEqual([issueId]);
      expect(getIssue(db, issueId)).toMatchObject({ status: "in_progress", attempt_count: 1 });
    } finally {
      db.close();
    }
  });

  test("reconciles a completed provider session and closes the Run", async () => {
    const db = await openFixtureDatabase();
    const provider = new CompletedExecutionProvider();
    try {
      insertProject(db, { id: "demo", provider: provider.id });
      const issueId = insertIssue(db, { projectId: "demo", title: "needs explicit status" });

      await runProjectLoopOnce({ database: db, projectId: "demo", providers: { [provider.id]: provider } });

      expect(getIssue(db, issueId)).toMatchObject({ status: "pending_verification" });
      expect(listIssueRuns(db, issueId)).toMatchObject([{
        status: "done",
        ended_at: expect.stringMatching(/Z$/)
      }]);
    } finally {
      db.close();
    }
  });

  test("turns an executor needs_user outcome into one alert and notification", async () => {
    const db = await openFixtureDatabase();
    const provider = new NeedsUserExecutionProvider();
    try {
      insertProject(db, { id: "demo", provider: provider.id });
      const issueId = insertIssue(db, { projectId: "demo", title: "needs credentials" });

      await runProjectLoopOnce({ database: db, projectId: "demo", providers: { [provider.id]: provider } });

      expect(getIssue(db, issueId)).toMatchObject({
        status: "failed",
        error: "缺少部署凭证"
      });
      expect(listIssueRuns(db, issueId).at(-1)).toMatchObject({
        status: "failed",
        ended_at: expect.stringMatching(/Z$/)
      });
      expect(listPiGuardianAlerts(db, { projectId: "demo", status: "open" }).filter((alert) => alert.issue_id === issueId)).toContainEqual(
        expect.objectContaining({ alert_type: "executor_needs_user", issue_id: issueId })
      );
      expect(listNotifications(db, { projectID: "demo" }).filter((notification) => notification.issue_id === issueId)).toContainEqual(
        expect.objectContaining({ event: "pi.needs_user", issue_id: issueId })
      );
    } finally {
      db.close();
    }
  });

  test("uses assigned executor profile for provider options and session linkage", async () => {
    const db = await openFixtureDatabase();
    const provider = new FakeExecutionProvider();
    try {
      insertProject(db, { id: "demo", provider: provider.id });
      insertAgentProfile(db, {
        id: "executor-fake",
        model: "profile-model",
        provider: provider.id
      });
      const issueId = insertIssue(db, {
        agentProfileId: "executor-fake",
        projectId: "demo",
        title: "profile selected"
      });

      await runProjectLoopOnce({ database: db, projectId: "demo", providers: { [provider.id]: provider } });

      expect(provider.inputs[0]).toMatchObject({
        approvalPolicy: "on-request",
        model: "profile-model",
        reasoningEffort: "high",
        sandbox: "danger-full-access"
      });
      expect(latestRun(db, issueId)).toMatchObject({
        agent_profile_id: "executor-fake",
        capability_summary: "issue_execution",
        selection_reason: "issue assigned agent_profile_id"
      });
      expect(getAgentSession(db, `fake-execution-only:fake-session-${issueId}`)).toMatchObject({
        agent_role: "executor",
        issue_id: issueId
      });
    } finally {
      db.close();
    }
  });

  test("freezes different Codex and Claude Work providers into Run and Attempt history", async () => {
    const db = await openFixtureDatabase();
    const codex = new NamedExecutionProvider("codex");
    const claude = new NamedExecutionProvider("claude");
    try {
      insertProject(db, { id: "demo", provider: "codex" });
      insertAgentProfile(db, { id: "codex-work", model: "gpt-5.6", provider: "codex" });
      insertAgentProfile(db, { id: "claude-work", model: "claude-sonnet", provider: "claude" });
      const codexIssue = insertIssue(db, {
        agentProfileId: "codex-work",
        priority: 10,
        projectId: "demo",
        title: "Codex Work"
      });
      const claudeIssue = insertIssue(db, {
        agentProfileId: "claude-work",
        priority: 5,
        projectId: "demo",
        title: "Claude Work"
      });
      const providers = { codex, claude } satisfies Partial<Record<ExecutorProviderId, ExecutorProvider>>;

      await runProjectLoopOnce({ database: db, projectId: "demo", providers });
      closeClaimedIssue(db, codexIssue);
      db.sqlite.run("update projects set provider='claude', default_agent_profile_id='claude-work' where id='demo'");
      await runProjectLoopOnce({ database: db, projectId: "demo", providers });

      expect(codex.inputs.map((input) => input.issueId)).toEqual([codexIssue]);
      expect(claude.inputs.map((input) => input.issueId)).toEqual([claudeIssue]);
      expect(listIssueRuns(db, codexIssue).at(-1)).toMatchObject({
        agent_profile_id: "codex-work",
        provider: "codex",
        provider_session_id: `codex-session-${codexIssue}`
      });
      expect(listIssueRuns(db, claudeIssue).at(-1)).toMatchObject({
        agent_profile_id: "claude-work",
        provider: "claude",
        provider_session_id: `claude-session-${claudeIssue}`
      });
      expect(latestAttempt(db, codexIssue)).toMatchObject({
        provider: "codex",
        provider_session_id: `codex-session-${codexIssue}`
      });
      expect(latestAttempt(db, claudeIssue)).toMatchObject({
        provider: "claude",
        provider_session_id: `claude-session-${claudeIssue}`
      });
    } finally {
      db.close();
    }
  });

  test("resolves issue, profile, and project service tier before provider execution", async () => {
    const db = await openFixtureDatabase();
    const provider = new FakeExecutionProvider();
    try {
      insertProject(db, { id: "demo", provider: provider.id, serviceTier: "project-fast" });
      const projectIssue = insertIssue(db, {
        projectId: "demo",
        priority: 6,
        title: "project speed"
      });

      await runProjectLoopOnce({ database: db, projectId: "demo", providers: { [provider.id]: provider } });
      closeClaimedIssue(db, projectIssue);

      insertAgentProfile(db, {
        id: "executor-fake",
        model: "profile-model",
        provider: provider.id,
        serviceTier: "profile-fast"
      });
      const profileIssue = insertIssue(db, {
        agentProfileId: "executor-fake",
        projectId: "demo",
        priority: 4,
        title: "profile speed"
      });
      const issueOverride = insertIssue(db, {
        projectId: "demo",
        priority: 5,
        serviceTier: "priority",
        title: "issue speed"
      });

      await runProjectLoopOnce({ database: db, projectId: "demo", providers: { [provider.id]: provider } });
      closeClaimedIssue(db, issueOverride);
      await runProjectLoopOnce({ database: db, projectId: "demo", providers: { [provider.id]: provider } });

      expect(provider.inputs.map((input) => ({
        issueId: input.issueId,
        serviceTier: input.serviceTier,
        serviceTierSource: input.serviceTierSource
      }))).toEqual([
        { issueId: projectIssue, serviceTier: "project-fast", serviceTierSource: "project" },
        { issueId: issueOverride, serviceTier: "priority", serviceTierSource: "issue" },
        { issueId: profileIssue, serviceTier: "profile-fast", serviceTierSource: "agent_profile" }
      ]);
      expect(latestRunMetadata(db, profileIssue)).toEqual({
        run_id: `fake-run-${profileIssue}`,
        service_tier: "profile-fast",
        service_tier_source: "agent_profile"
      });
      expect(latestRunMetadata(db, issueOverride)).toEqual({
        run_id: `fake-run-${issueOverride}`,
        service_tier: "priority",
        service_tier_source: "issue"
      });
      expect(latestRunMetadata(db, projectIssue)).toEqual({
        run_id: `fake-run-${projectIssue}`,
        service_tier: "project-fast",
        service_tier_source: "project"
      });
    } finally {
      db.close();
    }
  });

  test("passes uploaded attachment images to executor provider as local images", async () => {
    const db = await openFixtureDatabase();
    const provider = new FakeExecutionProvider();
    try {
      insertProject(db, { id: "demo", provider: provider.id });
      const imagePath = await insertUpload(db, "upload_issue_image");
      insertIssue(db, {
        description: `请按截图修复\n\n![shot](attachment://upload_issue_image)\n\n![dup](attachment://upload_issue_image)`,
        projectId: "demo",
        title: "image issue"
      });

      await runProjectLoopOnce({ database: db, projectId: "demo", providers: { [provider.id]: provider } });

      expect(provider.inputs[0]?.images).toEqual([{
        detail: "high",
        path: imagePath,
        type: "localImage"
      }]);
      expect(provider.inputs[0]?.prompt).toContain("attachment://upload_issue_image");
    } finally {
      db.close();
    }
  });

  test("keeps skill intent context small and avoids dumping the global skill registry", async () => {
    const db = await openFixtureDatabase();
    const provider = new FakeExecutionProvider();
    try {
      insertProject(db, { id: "demo", provider: provider.id });
      insertIssue(db, {
        projectId: "demo",
        recommendedSkillIntents: ["frontend-ui", "css-layout", "react-component-maintenance"],
        title: "frontend issue"
      });

      await runProjectLoopOnce({ database: db, projectId: "demo", providers: { [provider.id]: provider } });

      const prompt = provider.inputs[0]?.prompt ?? "";
      expect(prompt).toContain("## Skill Intent Context");
      expect(prompt).toContain(`Recommended skill intents: ["frontend-ui","css-layout","react-component-maintenance"]`);
      expect(prompt).not.toContain("Available skills metadata");
      expect(prompt).not.toContain("babysit-repo");
    } finally {
      db.close();
    }
  });

  test("marks provider failures failed and closes the open run with redacted error", async () => {
    const db = await openFixtureDatabase();
    const provider = new FailingExecutionProvider();
    try {
      insertProject(db, { id: "demo", provider: provider.id });
      const issueId = insertIssue(db, { projectId: "demo", title: "provider fails" });

      await runProjectLoopOnce({ database: db, projectId: "demo", providers: { [provider.id]: provider } });

      const issue = getIssue(db, issueId);
      const run = listIssueRuns(db, issueId).at(-1);
      expect(issue).toMatchObject({
        status: "failed",
        error: "provider failed CODEX_API_KEY=[redacted]"
      });
      expect(issue?.error).not.toContain("fixture-secret");
      expect(run).toMatchObject({
        status: "failed",
        exit_reason: "failed",
        error: "provider failed CODEX_API_KEY=[redacted]"
      });
      expect(run?.ended_at).not.toBe("");
    } finally {
      db.close();
    }
  });
});

type ProjectFixture = { autoRun?: number; cwd?: string; id: string; provider: string; serviceTier?: string };

type IssueFixture = {
  agentProfileId?: string;
  createdAt?: string;
  description?: string;
  priority?: number;
  projectId: string;
  recommendedSkillIntents?: string[];
  requiredSkillIntents?: string[];
  status?: string;
  serviceTier?: string;
  title: string;
};

function insertProject(db: RunnerDatabase, project: ProjectFixture): void {
  db.sqlite.run(
    `insert into projects (id, name, cwd, provider, auto_run, default_service_tier, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?)`,
    [project.id, project.id, project.cwd ?? `/tmp/${project.id}`, project.provider, project.autoRun ?? 0,
      project.serviceTier ?? "",
      "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
}

function insertIssue(db: RunnerDatabase, issue: IssueFixture): number {
  const status = issue.status ?? "todo";
  const priority = issue.priority ?? 0;
  const createdAt = issue.createdAt ?? "2026-01-01T00:00:00Z";
  db.sqlite.run(
    `insert into issues (project_id, title, description, status, priority, agent_profile_id, service_tier,
      required_skill_intents_json, recommended_skill_intents_json, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      issue.projectId, issue.title, issue.description ?? "", status, priority,
      issue.agentProfileId ?? "", issue.serviceTier ?? "", JSON.stringify(issue.requiredSkillIntents ?? []),
      JSON.stringify(issue.recommendedSkillIntents ?? []), createdAt, createdAt
    ]
  );
  const row = db.sqlite.query<{ id: number }, []>("select last_insert_rowid() as id").get();
  if (!row) throw new Error("missing inserted issue id");
  return row.id;
}

async function insertUpload(db: RunnerDatabase, id: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-upload-"));
  tempRoots.push(root);
  const path = join(root, `${id}.png`);
  await mkdir(root, { recursive: true });
  await writeFile(path, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  db.sqlite.run(
    `insert into uploads (id, original_name, mime_type, size_bytes, sha256, storage_path, created_at)
     values (?, ?, ?, ?, ?, ?, ?)`,
    [id, "shot.png", "image/png", 4, "fixture-sha", path, "2026-01-01T00:00:00Z"]
  );
  return path;
}

function insertAgentProfile(db: RunnerDatabase, input: { id: string; model: string; provider: string; serviceTier?: string }): void {
  db.sqlite.run(
    `insert into agent_profiles (id, name, provider, model, reasoning_effort, service_tier,
      approval_policy, sandbox, skill_intents_json, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.id, input.id, input.provider, input.model, "high", input.serviceTier ?? "", "on-request",
      "danger-full-access", "[]", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"
    ]
  );
}

function latestRunMetadata(db: RunnerDatabase, issueId: number): Record<string, unknown> {
  const row = db.sqlite.query<{ runtime_metadata_json: string }, [number]>(
    `select runtime_metadata_json from issue_runs where issue_id=? order by attempt desc limit 1`
  ).get(issueId);
  return JSON.parse(row?.runtime_metadata_json || "{}") as Record<string, unknown>;
}

function latestRun(db: RunnerDatabase, issueId: number): Record<string, unknown> | null {
  return db.sqlite.query<Record<string, unknown>, [number]>(
    `select agent_profile_id, capability_summary, selection_reason
     from issue_runs where issue_id=? order by attempt desc limit 1`
  ).get(issueId);
}

function latestAttempt(db: RunnerDatabase, issueId: number): Record<string, unknown> | null {
  return db.sqlite.query<Record<string, unknown>, [number]>(`
    select a.provider, a.provider_session_id, a.provider_turn_id
    from run_attempts a join issue_runs r on r.id=a.issue_run_id
    where r.issue_id=? order by a.sequence desc limit 1
  `).get(issueId);
}

function insertOpenRun(db: RunnerDatabase, issueID: number): void {
  db.sqlite.run(
    `insert into issue_runs (id, issue_id, attempt, status, started_at)
     values (?, ?, ?, ?, ?)`,
    [`issue-${issueID}-attempt-1`, issueID, 1, "in_progress", "2026-01-01T00:00:00Z"]
  );
}

function closeClaimedIssue(db: RunnerDatabase, issueID: number): void {
  db.sqlite.run("update issues set status='done' where id=?", [issueID]);
  db.sqlite.run("update issue_runs set status='done', ended_at=? where issue_id=? and ended_at=''", [
    "2026-01-01T00:01:00Z",
    issueID
  ]);
}

function listEventTypes(db: RunnerDatabase, issueID: number): string[] {
  return db.sqlite.query<{ type: string }, [number]>(
    "select type from issue_events where issue_id=? order by id asc"
  ).all(issueID).map((event) => event.type);
}

function latestEventPayload(
  db: RunnerDatabase,
  issueID: number,
  type: string
): Record<string, unknown> {
  const payload = db.sqlite.query<{ payload: string }, [number, string]>(`
    select payload from issue_events where issue_id=? and type=? order by id desc limit 1
  `).get(issueID, type)?.payload ?? "{}";
  return JSON.parse(payload) as Record<string, unknown>;
}

async function waitFor(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(5);
  }
  throw new Error("condition timed out");
}
