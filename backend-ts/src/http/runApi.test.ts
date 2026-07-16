import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import type {
  ExecutorProvider,
  InterruptInput,
  ProviderRunInput,
  SessionMessageInput
} from "../providers/types.ts";
import { createDefaultRouter, createRequestHandler } from "./server.ts";

const BASE_URL = "http://127.0.0.1:3008";
const AUTH_TOKEN = "run-api-test-token";
const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) {
    const path = tempRoots.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

describe("Run HTTP API", () => {
  test("lists and details a large Run set with bounded pagination and dimension filters", async () => {
    const db = await openFixtureDatabase();
    try {
      insertProject(db, "demo");
      insertProject(db, "other");
      for (let index = 1; index <= 125; index += 1) {
        const issueID = insertIssue(db, "demo", `Work ${String(index).padStart(3, "0")}`, "done");
        insertRun(db, issueID, "done", {
          endedAt: timestamp(index + 200),
          sessionID: `session-${index}`,
          startedAt: timestamp(index),
          turnID: `turn-${index}`
        });
      }
      const otherIssueID = insertIssue(db, "other", "Other Work", "failed");
      insertRun(db, otherIssueID, "failed", { endedAt: timestamp(500), startedAt: timestamp(499) });
      const router = createDefaultRouter({ database: db });

      const response = await router.handle(new Request(
        `${BASE_URL}/api/runs?project_id=demo&provider=codex&status=succeeded&sort=created_at&order=asc&page=3&page_size=50`
      ));
      const body = await response.json() as Record<string, any>;
      const invalidPage = await router.handle(new Request(`${BASE_URL}/api/runs?page_size=101`));
      const missingProject = await router.handle(new Request(`${BASE_URL}/api/runs?project_id=missing`));
      const runID = String(body.items[0]?.id);
      const workID = String(body.items[0]?.work_id);
      const workFiltered = await router.handle(new Request(
        `${BASE_URL}/api/runs?work_id=${encodeURIComponent(workID)}`
      ));
      const detail = await router.handle(new Request(`${BASE_URL}/api/runs/${encodeURIComponent(runID)}`));
      const detailBody = await detail.json() as Record<string, any>;

      expect(response.status).toBe(200);
      expect(body).toMatchObject({
        compatibility: { dual_write: "none", read_authority: "issue_runs" },
        page: 3,
        page_size: 50,
        total: 125,
        total_pages: 3
      });
      expect(body.items).toHaveLength(25);
      expect(body.items[0]).toMatchObject({
        attempt_count: 1,
        progress: { attempt_status: "succeeded", phase: "succeeded" },
        project_id: "demo",
        provider: "codex",
        status: "succeeded",
        trigger: "initial"
      });
      expect(invalidPage.status).toBe(400);
      expect(await invalidPage.json()).toEqual({ code: "invalid_request", message: "page_size must not exceed 100" });
      expect(missingProject.status).toBe(404);
      expect(workFiltered.status).toBe(200);
      expect(await workFiltered.json()).toMatchObject({ items: [{ id: runID, work_id: workID }], total: 1 });
      expect(detail.status).toBe(200);
      expect(detailBody.run).toMatchObject({
        attempts: [{
          kind: "initial",
          links: { provider_session: expect.stringContaining("/api/sessions/") },
          provider_ref: { session_ref: expect.any(String), turn_ref: expect.any(String) },
          status: "succeeded"
        }],
        cost: { usage: { completeness: "unavailable" } },
        links: {
          evidence: expect.stringContaining("event-summaries"),
          lifecycle_audit: expect.stringContaining("run.lifecycle.intent.v1"),
          logs: expect.stringContaining("type=issue.log")
        }
      });
    } finally {
      db.close();
    }
  });

  test("requires bearer auth and performs idempotent interrupt with audited revisions", async () => {
    const db = await openFixtureDatabase();
    const provider = new ControlProvider();
    try {
      insertProject(db, "demo");
      const issueID = insertIssue(db, "demo", "Interrupt", "in_progress");
      const runID = insertRun(db, issueID, "in_progress", {
        sessionID: "thread-interrupt",
        startedAt: timestamp(1),
        turnID: "turn-interrupt"
      });
      const handle = createRequestHandler(createDefaultRouter({ database: db, providers: { codex: provider } }), AUTH_TOKEN);
      const payload = {
        audit: audit("interrupt-1", "user"),
        expected_attempt_revision: 0,
        expected_revision: 0
      };

      const unauthorized = await handle(jsonRequest(`/api/runs/${encodeURIComponent(runID)}/actions/interrupt`, payload));
      const interrupted = await handle(authenticatedJsonRequest(
        `/api/runs/${encodeURIComponent(runID)}/actions/interrupt`, payload
      ));
      const replay = await handle(authenticatedJsonRequest(
        `/api/runs/${encodeURIComponent(runID)}/actions/interrupt`, payload
      ));
      const interruptedBody = await interrupted.json() as Record<string, any>;
      const replayBody = await replay.json() as Record<string, any>;

      expect(unauthorized.status).toBe(401);
      expect(interrupted.status).toBe(200);
      expect(replay.status).toBe(200);
      expect(provider.interrupts).toHaveLength(1);
      expect(interruptedBody).toMatchObject({
        mutation: { action: "interrupt", applied: true, audit_event_id: "interrupt-1", replayed: false },
        run: { progress: { attempt_status: "interrupted" }, revision: 2 }
      });
      expect(replayBody.mutation.replayed).toBe(true);
      expect(lifecycleEvents(db, issueID, "interrupt-1")).toEqual([
        "run.lifecycle.intent.v1",
        "run.lifecycle.outcome.v1"
      ]);
    } finally {
      db.close();
    }
  });

  test("resumes the same provider session once and rejects a stale concurrent command", async () => {
    const db = await openFixtureDatabase();
    const provider = new ControlProvider();
    try {
      insertProject(db, "demo");
      const issueID = insertIssue(db, "demo", "Resume", "in_progress");
      const runID = insertRun(db, issueID, "in_progress", {
        sessionID: "thread-resume",
        startedAt: timestamp(1),
        turnID: "turn-old"
      });
      db.sqlite.run(`update run_attempts set status='succeeded', revision=1, ended_at=?,
        terminal_reason='provider turn completed', terminal_source_ref='fixture:completed', updated_at=?
        where run_id=?`, [timestamp(2), timestamp(2), runID]);
      const handle = createRequestHandler(createDefaultRouter({ database: db, providers: { codex: provider } }), AUTH_TOKEN);
      const payload = {
        audit: audit("resume-1", "supervisor"),
        expected_attempt_revision: 1,
        expected_revision: 0,
        prompt: "Continue from the verified provider state."
      };

      const resumed = await handle(authenticatedJsonRequest(
        `/api/runs/${encodeURIComponent(runID)}/actions/resume`, payload
      ));
      const replay = await handle(authenticatedJsonRequest(
        `/api/runs/${encodeURIComponent(runID)}/actions/resume`, payload
      ));
      const stale = await handle(authenticatedJsonRequest(
        `/api/runs/${encodeURIComponent(runID)}/actions/resume`, {
          ...payload,
          audit: audit("resume-stale", "supervisor")
        }
      ));
      const resumedBody = await resumed.json() as Record<string, any>;
      const staleBody = await stale.json() as Record<string, any>;

      expect(resumed.status).toBe(200);
      expect(replay.status).toBe(200);
      expect(stale.status).toBe(409);
      expect(provider.messages).toEqual([{
        prompt: "Continue from the verified provider state.",
        sessionId: "thread-resume"
      }]);
      expect(resumedBody).toMatchObject({
        mutation: { action: "resume", audit_event_id: "resume-1", replayed: false },
        run: {
          attempt_count: 2,
          attempts: [
            { kind: "initial", status: "succeeded" },
            { kind: "resume", provider_ref: { session_ref: "thread-resume", turn_ref: "turn-resumed" }, status: "running" }
          ],
          progress: { attempt_sequence: 2, attempt_status: "running" },
          revision: 2
        }
      });
      expect(staleBody.code).toBe("run_precondition_failed");
      expect(String(staleBody.message)).toContain("Run revision mismatch");
    } finally {
      db.close();
    }
  });

  test("serializes retry by expected revision and records rejected concurrent requests", async () => {
    const db = await openFixtureDatabase();
    try {
      insertProject(db, "demo");
      const issueID = insertIssue(db, "demo", "Retry", "failed");
      const runID = insertRun(db, issueID, "failed", {
        endedAt: timestamp(2),
        startedAt: timestamp(1)
      });
      const handle = createRequestHandler(createDefaultRouter({ database: db }), AUTH_TOKEN);
      const payload = { audit: audit("retry-1", "user"), expected_revision: 0 };

      const retried = await handle(authenticatedJsonRequest(
        `/api/runs/${encodeURIComponent(runID)}/actions/retry`, payload
      ));
      const replay = await handle(authenticatedJsonRequest(
        `/api/runs/${encodeURIComponent(runID)}/actions/retry`, payload
      ));
      const stale = await handle(authenticatedJsonRequest(
        `/api/runs/${encodeURIComponent(runID)}/actions/retry`, {
          audit: audit("retry-stale", "user"),
          expected_revision: 0
        }
      ));
      const retriedBody = await retried.json() as Record<string, any>;
      const staleBody = await stale.json() as Record<string, any>;

      expect(retried.status).toBe(200);
      expect(replay.status).toBe(200);
      expect(stale.status).toBe(409);
      expect(retriedBody).toMatchObject({
        mutation: { action: "retry", applied: true, operation: "retry", requested_sequence: 2 },
        run: { revision: 1 }
      });
      expect(staleBody).toMatchObject({
        code: "run_precondition_failed",
        mutation: { action: "retry", audit_event_id: "retry-stale", operation: "retry" },
        violations: expect.arrayContaining([
          "Run revision mismatch: expected 0, actual 1",
          "a new Run request is already pending"
        ])
      });
      expect(issueStatus(db, issueID)).toBe("todo");
      expect(lifecycleEvents(db, issueID, "retry-1")).toEqual(["run.lifecycle.run_requested.v1"]);
    } finally {
      db.close();
    }
  });

  test("rejects untrusted actor kinds before writing lifecycle audit", async () => {
    const db = await openFixtureDatabase();
    try {
      insertProject(db, "demo");
      const issueID = insertIssue(db, "demo", "Permission", "failed");
      const runID = insertRun(db, issueID, "failed", { endedAt: timestamp(2), startedAt: timestamp(1) });
      const handle = createRequestHandler(createDefaultRouter({ database: db }), AUTH_TOKEN);

      const response = await handle(authenticatedJsonRequest(
        `/api/runs/${encodeURIComponent(runID)}/actions/retry`,
        { audit: audit("llm-gate", "llm"), expected_revision: 0 }
      ));

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ code: "invalid_request", message: "audit.actor.kind is invalid" });
      expect(lifecycleEvents(db, issueID, "llm-gate")).toEqual([]);
    } finally {
      db.close();
    }
  });
});

class ControlProvider implements ExecutorProvider {
  readonly id = "codex" as const;
  readonly capabilities = ["issue_execution", "resume_session", "interrupt"] as const;
  readonly interrupts: InterruptInput[] = [];
  readonly messages: SessionMessageInput[] = [];

  async run(_input: ProviderRunInput) {
    throw new Error("not implemented");
  }

  async interrupt(input: InterruptInput): Promise<void> {
    this.interrupts.push(input);
  }

  async sendSessionMessage(input: SessionMessageInput) {
    this.messages.push(input);
    return {
      provider: "codex" as const,
      provider_session_id: input.sessionId,
      sessionId: input.sessionId,
      turn_id: "turn-resumed"
    };
  }
}

async function openFixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-bun-run-api-"));
  tempRoots.push(root);
  return openDatabase({ stateDir: join(root, "state") });
}

function insertProject(db: RunnerDatabase, id: string): void {
  db.sqlite.run(
    `insert into projects (id, name, cwd, provider, auto_run, created_at, updated_at)
     values (?, ?, ?, 'codex', 0, ?, ?)`,
    [id, id, `/tmp/${id}`, timestamp(0), timestamp(0)]
  );
}

function insertIssue(db: RunnerDatabase, projectID: string, title: string, status: string): number {
  db.sqlite.run(
    `insert into issues (project_id, title, status, created_at, updated_at) values (?, ?, ?, ?, ?)`,
    [projectID, title, status, timestamp(0), timestamp(0)]
  );
  const row = db.sqlite.query<{ id: number }, []>("select last_insert_rowid() as id").get();
  if (!row) throw new Error("missing inserted issue id");
  return row.id;
}

function insertRun(
  db: RunnerDatabase,
  issueID: number,
  status: string,
  input: { endedAt?: string; sessionID?: string; startedAt: string; turnID?: string }
): string {
  const id = `issue-${issueID}-attempt-1`;
  db.sqlite.run(
    `insert into issue_runs
      (id, issue_id, attempt, status, provider, provider_session_id, provider_turn_id,
       started_at, ended_at, exit_reason, error)
     values (?, ?, 1, ?, 'codex', ?, ?, ?, ?, ?, ?)`,
    [
      id,
      issueID,
      status,
      input.sessionID ?? "",
      input.turnID ?? "",
      input.startedAt,
      input.endedAt ?? "",
      status === "done" ? "completed" : status === "failed" ? "provider failed" : "",
      status === "failed" ? "fixture failure" : ""
    ]
  );
  return `xw:run:issue_runs:${id}`;
}

function audit(eventID: string, kind: string): Record<string, unknown> {
  return {
    actor: { id: `${kind}:fixture`, kind },
    correlation_id: `correlation:${eventID}`,
    event_id: eventID,
    occurred_at: "2026-07-16T00:00:00Z",
    reason: `control ${eventID}`
  };
}

function jsonRequest(path: string, body: unknown): Request {
  return new Request(`${BASE_URL}${path}`, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "POST"
  });
}

function authenticatedJsonRequest(path: string, body: unknown): Request {
  const request = jsonRequest(path, body);
  request.headers.set("authorization", `Bearer ${AUTH_TOKEN}`);
  return request;
}

function lifecycleEvents(db: RunnerDatabase, issueID: number, eventID: string): string[] {
  return db.sqlite.query<{ type: string }, [number, string]>(`
    select type from issue_events
    where issue_id=? and json_valid(payload) and json_extract(payload, '$.event_id')=?
    order by id asc
  `).all(issueID, eventID).map((row) => row.type);
}

function issueStatus(db: RunnerDatabase, issueID: number): string {
  return db.sqlite.query<{ status: string }, [number]>("select status from issues where id=?").get(issueID)?.status ?? "";
}

function timestamp(seconds: number): string {
  return new Date(Date.UTC(2026, 0, 1, 0, 0, seconds)).toISOString();
}
