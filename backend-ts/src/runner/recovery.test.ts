import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { getIssue, listIssueRuns } from "../db/repositories/issues.ts";
import { recoverInProgressIssues } from "./recovery.ts";
import type { ExecutorProvider, ProviderRecoveryInput, ProviderRunInput, ProviderRunResult } from "../providers/types.ts";

const tempRoots: string[] = [];

class RecoveringCodexProvider implements ExecutorProvider {
  readonly id = "codex" as const;
  readonly capabilities = ["issue_execution", "resume_session"] as const;
  readonly inputs: ProviderRecoveryInput[] = [];

  async run(): Promise<{ runId: string }> {
    throw new Error("run should not be called during recovery");
  }

  async recover(input: ProviderRecoveryInput): Promise<ProviderRunResult> {
    this.inputs.push(input);
    return {
      runId: "codex:thread-recover:turn-recovered",
      session: { provider: "codex" as const, sessionId: input.session.sessionId, turnId: "turn-recovered" }
    };
  }
}

class TransientRecoveryProvider implements ExecutorProvider {
  readonly id = "claude" as const;
  readonly capabilities = ["issue_execution", "resume_session"] as const;
  readonly inputs: ProviderRecoveryInput[] = [];

  async run(_input: ProviderRunInput): Promise<ProviderRunResult> {
    throw new Error("run should not be called during recovery");
  }

  async recover(input: ProviderRecoveryInput): Promise<ProviderRunResult> {
    this.inputs.push(input);
    throw new Error("Claude Code run timed out after 10000ms");
  }
}

async function openFixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-bun-recovery-"));
  tempRoots.push(root);
  return openDatabase({ stateDir: join(root, "state") });
}

afterEach(async () => {
  while (tempRoots.length > 0) {
    const path = tempRoots.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

describe("Bun in-progress issue recovery", () => {
  test("resumes recoverable in_progress issues and keeps them waiting for explicit status", async () => {
    const db = await openFixtureDatabase();
    const provider = new RecoveringCodexProvider();
    try {
      insertProject(db, { id: "demo", provider: provider.id });
      const issueId = insertIssue(db, {
        codexThreadId: "thread-recover",
        codexTurnId: "turn-old",
        projectId: "demo",
        status: "in_progress",
        title: "recover me"
      });
      insertOpenRun(db, {
        issueId,
        provider: "codex",
        providerSessionId: "thread-recover",
        providerTurnId: "turn-old"
      });

      const result = await recoverInProgressIssues({ database: db, providers: { codex: provider } });

      expect(result).toEqual({ deferred: 0, failed: 0, recovered: 1, requeued: 0 });
      expect(provider.inputs).toHaveLength(1);
      expect(provider.inputs[0]).toMatchObject({
        issueId,
        projectId: "demo",
        session: { provider: "codex", sessionId: "thread-recover", turnId: "turn-old" }
      });
      expect(provider.inputs[0].prompt).toContain("codex-issue-runner issue update");
      expect(getIssue(db, issueId)).toMatchObject({ status: "in_progress", error: "" });
      expect(listIssueRuns(db, issueId)).toMatchObject([{
        status: "in_progress",
        provider_session_id: "thread-recover",
        provider_turn_id: "turn-recovered",
        ended_at: ""
      }]);
      expect(listEventTypes(db)).toEqual([
        "run.lifecycle.intent.v1",
        "issue.recovery_started",
        "run.lifecycle.outcome.v1",
        "issue.recovery_turn_started"
      ]);
    } finally {
      db.close();
    }
  });

  test("fails recoverable sessions when the provider cannot resume them", async () => {
    const db = await openFixtureDatabase();
    try {
      insertProject(db, { id: "demo", provider: "codex" });
      const issueId = insertIssue(db, {
        codexThreadId: "thread-known",
        projectId: "demo",
        status: "in_progress",
        title: "known session"
      });
      insertOpenRun(db, { issueId, provider: "codex" });

      const result = await recoverInProgressIssues({ database: db, providers: {} });

      const issue = getIssue(db, issueId);
      const run = listIssueRuns(db, issueId).at(-1);
      expect(result).toEqual({ deferred: 0, failed: 1, recovered: 0, requeued: 0 });
      expect(issue).toMatchObject({
        status: "failed",
        error: "provider codex does not support recovery"
      });
      expect(run).toMatchObject({
        status: "failed",
        exit_reason: "failed",
        error: "provider codex does not support recovery"
      });
      expect(run?.ended_at).not.toBe("");
      expect(listEventTypes(db)).toEqual([
        "issue.status_changed",
        "issue.error",
        "issue.recovery_failed"
      ]);
    } finally {
      db.close();
    }
  });

  test("defers provider infra transient recovery failures to PI without closing the run", async () => {
    const db = await openFixtureDatabase();
    const provider = new TransientRecoveryProvider();
    try {
      insertProject(db, { id: "demo", provider: provider.id });
      const issueId = insertIssue(db, {
        codexThreadId: "thread-known",
        projectId: "demo",
        status: "in_progress",
        title: "known session"
      });
      insertOpenRun(db, {
        issueId,
        provider: provider.id,
        providerSessionId: "thread-known",
        providerTurnId: "turn-known"
      });

      const result = await recoverInProgressIssues({ database: db, providers: { [provider.id]: provider } });

      const issue = getIssue(db, issueId);
      const run = listIssueRuns(db, issueId).at(-1);
      expect(result).toEqual({ deferred: 1, failed: 0, recovered: 0, requeued: 0 });
      expect(issue).toMatchObject({
        status: "in_progress",
        error: "Claude Code run timed out after 10000ms"
      });
      expect(run).toMatchObject({
        status: "in_progress",
        ended_at: "",
        error: "Claude Code run timed out after 10000ms"
      });
      expect(listEventTypes(db)).toEqual([
        "run.lifecycle.intent.v1",
        "issue.recovery_started",
        "run.lifecycle.outcome.v1",
        "issue.provider_deferred",
        "issue.recovery_deferred"
      ]);
    } finally {
      db.close();
    }
  });

  test("requeues an already deferred startup failure that never created a provider session", async () => {
    const db = await openFixtureDatabase();
    try {
      insertProject(db, { id: "demo", provider: "claude" });
      const issueId = insertIssue(db, {
        projectId: "demo",
        status: "in_progress",
        title: "startup timeout"
      });
      insertOpenRun(db, { issueId, provider: "claude" });
      db.sqlite.run("update issues set error=? where id=?", [
        "codex app-server request timed out after 10000ms: initialize",
        issueId
      ]);
      db.sqlite.run(
        `insert into issue_events (issue_id, type, payload, created_at) values (?, ?, ?, ?)`,
        [issueId, "issue.provider_deferred", JSON.stringify({
          error: "codex app-server request timed out after 10000ms: initialize",
          provider: "claude",
          reason: "provider_infra_transient"
        }), "2026-01-01T00:00:00Z"]
      );

      const result = await recoverInProgressIssues({ database: db, providers: {} });

      const issue = getIssue(db, issueId);
      const run = listIssueRuns(db, issueId).at(-1);
      expect(result).toEqual({ deferred: 0, failed: 0, recovered: 0, requeued: 1 });
      expect(issue).toMatchObject({ status: "todo", error: "" });
      expect(run).toMatchObject({
        status: "todo",
        ended_at: expect.stringMatching(/Z$/),
        error: "",
        exit_reason: "status_changed",
        provider_session_id: "",
        provider_turn_id: ""
      });
      expect(listEventTypes(db)).toEqual([
        "issue.provider_deferred",
        "issue.status_changed",
        "issue.recovery_requeued"
      ]);
    } finally {
      db.close();
    }
  });

  test("requeues a startup failure instead of resuming the previous attempt compatibility session", async () => {
    const db = await openFixtureDatabase();
    try {
      insertProject(db, { id: "demo", provider: "codex" });
      const issueId = insertIssue(db, {
        codexThreadId: "thread-attempt-1",
        projectId: "demo",
        status: "in_progress",
        title: "retry startup timeout"
      });
      db.sqlite.run(
        `insert into issue_runs
          (id, issue_id, attempt, status, provider, provider_session_id, provider_turn_id,
           codex_thread_id, codex_turn_id, started_at, ended_at, exit_reason)
         values (?, ?, 1, 'failed', 'codex', 'thread-attempt-1', 'turn-attempt-1',
           'thread-attempt-1', 'turn-attempt-1', ?, ?, 'failed')`,
        [`issue-${issueId}-attempt-1`, issueId, "2026-01-01T00:00:00Z", "2026-01-01T00:01:00Z"]
      );
      db.sqlite.run(
        `insert into issue_runs
          (id, issue_id, attempt, status, provider, provider_session_id, provider_turn_id, started_at, ended_at)
         values (?, ?, 2, 'in_progress', 'codex', '', '', ?, '')`,
        [`issue-${issueId}-attempt-2`, issueId, "2026-01-01T00:02:00Z"]
      );
      db.sqlite.run("update issues set error=? where id=?", [
        "codex thread/start failed: codex app-server request timed out after 90000ms: thread/start",
        issueId
      ]);

      const result = await recoverInProgressIssues({ database: db, providers: {} });

      expect(result).toEqual({ deferred: 0, failed: 0, recovered: 0, requeued: 1 });
      expect(getIssue(db, issueId)).toMatchObject({
        status: "todo",
        error: "",
        codex_thread_id: "",
        codex_turn_id: ""
      });
      expect(listIssueRuns(db, issueId).at(-1)).toMatchObject({
        attempt: 2,
        status: "todo",
        provider_session_id: "",
        provider_turn_id: "",
        exit_reason: "status_changed"
      });
      expect(listEventTypes(db)).toEqual([
        "issue.status_changed",
        "issue.recovery_requeued"
      ]);
    } finally {
      db.close();
    }
  });

  test("requeues an in_progress claim that never created a provider session", async () => {
    const db = await openFixtureDatabase();
    try {
      insertProject(db, { id: "demo", provider: "codex" });
      const issueId = insertIssue(db, { projectId: "demo", status: "in_progress", title: "unstarted claim" });
      insertOpenRun(db, { issueId, provider: "codex" });

      const result = await recoverInProgressIssues({ database: db, providers: {} });

      const issue = getIssue(db, issueId);
      const run = listIssueRuns(db, issueId).at(-1);
      expect(result).toEqual({ deferred: 0, failed: 0, recovered: 0, requeued: 1 });
      expect(issue).toMatchObject({ status: "todo", error: "" });
      expect(run).toMatchObject({
        status: "todo",
        exit_reason: "status_changed",
        provider_session_id: "",
        provider_turn_id: ""
      });
      expect(run?.ended_at).not.toBe("");
      expect(listEventTypes(db)).toEqual([
        "issue.status_changed",
        "issue.recovery_requeued"
      ]);
    } finally {
      db.close();
    }
  });

  test("reopens the persisted database after a crash, recovers once, and leaves a terminal issue untouched", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-runner-restart-e2e-"));
    tempRoots.push(root);
    const stateDir = join(root, "state");
    const beforeCrash = await openDatabase({ stateDir });
    const provider = new RecoveringCodexProvider();
    let recoverableIssueID = 0;
    let terminalIssueID = 0;
    try {
      insertProject(beforeCrash, { id: "demo", provider: "codex" });
      recoverableIssueID = insertIssue(beforeCrash, {
        codexThreadId: "thread-crash", codexTurnId: "turn-before-crash", projectId: "demo", status: "in_progress", title: "resume after crash"
      });
      insertOpenRun(beforeCrash, {
        issueId: recoverableIssueID, provider: "codex", providerSessionId: "thread-crash", providerTurnId: "turn-before-crash"
      });
      terminalIssueID = insertIssue(beforeCrash, { projectId: "demo", status: "done", title: "already terminal" });
      beforeCrash.sqlite.run(`insert into issue_runs (id, issue_id, attempt, status, provider, started_at, ended_at, exit_reason)
        values (?, ?, 1, 'done', 'codex', ?, ?, 'status_changed')`, [
        `issue-${terminalIssueID}-attempt-1`, terminalIssueID, "2026-01-01T00:00:00Z", "2026-01-01T00:01:00Z"
      ]);
    } finally {
      beforeCrash.close();
    }

    const restarted = await openDatabase({ stateDir });
    try {
      const result = await recoverInProgressIssues({ database: restarted, providers: { codex: provider } });

      expect(result).toEqual({ deferred: 0, failed: 0, recovered: 1, requeued: 0 });
      expect(provider.inputs).toHaveLength(1);
      expect(getIssue(restarted, recoverableIssueID)).toMatchObject({ status: "in_progress" });
      expect(getIssue(restarted, terminalIssueID)).toMatchObject({ status: "done" });
      expect(listIssueRuns(restarted, terminalIssueID)).toMatchObject([{ status: "done", ended_at: "2026-01-01T00:01:00Z" }]);
    } finally {
      restarted.close();
    }
  });

  test("makes a second reconciliation of an already requeued claim a no-op", async () => {
    const db = await openFixtureDatabase();
    try {
      insertProject(db, { id: "demo", provider: "codex" });
      const issueID = insertIssue(db, { projectId: "demo", status: "in_progress", title: "requeue once" });
      insertOpenRun(db, { issueId: issueID, provider: "codex" });

      expect(await recoverInProgressIssues({ database: db, providers: {} }))
        .toEqual({ deferred: 0, failed: 0, recovered: 0, requeued: 1 });
      expect(await recoverInProgressIssues({ database: db, providers: {} }))
        .toEqual({ deferred: 0, failed: 0, recovered: 0, requeued: 0 });
      expect(getIssue(db, issueID)).toMatchObject({ status: "todo" });
      expect(listEventTypes(db).filter((type) => type === "issue.recovery_requeued")).toHaveLength(1);
    } finally {
      db.close();
    }
  });
});

type ProjectFixture = { id: string; provider: string };

type IssueFixture = {
  codexThreadId?: string;
  codexTurnId?: string;
  projectId: string;
  status: string;
  title: string;
};

type RunFixture = {
  issueId: number;
  provider: string;
  providerSessionId?: string;
  providerTurnId?: string;
};

function insertProject(db: RunnerDatabase, project: ProjectFixture): void {
  db.sqlite.run(
    `insert into projects (id, name, cwd, provider, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?)`,
    [project.id, project.id, `/tmp/${project.id}`, project.provider, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
}

function insertIssue(db: RunnerDatabase, issue: IssueFixture): number {
  db.sqlite.run(
    `insert into issues (project_id, title, status, codex_thread_id, codex_turn_id, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?)`,
    [
      issue.projectId,
      issue.title,
      issue.status,
      issue.codexThreadId ?? "",
      issue.codexTurnId ?? "",
      "2026-01-01T00:00:00Z",
      "2026-01-01T00:00:00Z"
    ]
  );
  const row = db.sqlite.query<{ id: number }, []>("select last_insert_rowid() as id").get();
  if (!row) throw new Error("missing inserted issue id");
  return row.id;
}

function insertOpenRun(db: RunnerDatabase, run: RunFixture): void {
  db.sqlite.run(
    `insert into issue_runs
      (id, issue_id, attempt, status, provider, provider_session_id, provider_turn_id, started_at)
     values (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      `issue-${run.issueId}-attempt-1`,
      run.issueId,
      1,
      "in_progress",
      run.provider,
      run.providerSessionId ?? "",
      run.providerTurnId ?? "",
      "2026-01-01T00:00:00Z"
    ]
  );
}

function listEventTypes(db: RunnerDatabase): string[] {
  return db.sqlite.query<{ type: string }, []>(
    "select type from issue_events order by id asc"
  ).all().map((event) => event.type);
}
