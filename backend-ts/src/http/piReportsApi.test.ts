import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { EventBus } from "../events/bus.ts";
import { createDefaultRouter } from "./server.ts";

const BASE_URL = "http://127.0.0.1:3008";
const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) await rm(root, { recursive: true, force: true });
  }
});

describe("PI reports API", () => {
  test("generates a manual report with evidence links, escalation, verification gap, usage, and SSE notification", async () => {
    const root = await tempDir("codex-runner-pi-reports-api-");
    const database = await openDatabase({ stateDir: join(root, "state") });
    const sessionsDir = join(root, "sessions");
    const bus = new EventBus();
    const events = bus.subscribe();
    try {
      insertProject(database, "demo");
      const done = insertIssue(database, "demo", {
        codexThreadID: "thread-done",
        error: "bun test passed",
        status: "done",
        title: "Completed issue"
      });
      const failed = insertIssue(database, "demo", {
        error: "approval denied; waiting for user input",
        status: "failed",
        title: "Needs user"
      });
      const weakDone = insertIssue(database, "demo", { status: "done", title: "Weak done" });
      insertRun(database, done, "issue-done-attempt-1", "done", "thread-done");
      insertSession(database, done, "thread-done");
      insertHeartbeat(database, "demo", "hb-1");
      insertAudit(database, "demo", failed, "act-1");
      await writeUsage(sessionsDir, "thread-done", "/tmp/demo", 15);

      const router = createDefaultRouter({ bus, codexSessionsDir: sessionsDir, database });
      const response = await request(router, "/api/pi/reports/generate", {
        project_id: "demo",
        since: "2026-06-03T00:00:00Z",
        type: "night_run",
        until: "2026-06-04T00:00:00Z"
      });
      const body = await response.json() as Record<string, any>;
      const event = await nextEvent(events);

      expect(response.status).toBe(201);
      expect(body).toMatchObject({ project_id: "demo", type: "night_run" });
      expect(body.completed_issues).toEqual([expect.objectContaining({
        evidence_links: expect.objectContaining({
          issue: `/api/issues/${done}`,
          runs: `/api/issues/${done}/runs`,
          session: "/api/sessions/codex:thread-done"
        }),
        id: done
      })]);
      expect(body.failed_retry_summary.failed_issues).toEqual([expect.objectContaining({
        evidence_links: expect.objectContaining({ audit: "/api/pi/audit-events?project_id=demo&issue_id=" + failed }),
        id: failed
      })]);
      expect(body.blocked_escalations).toEqual([expect.objectContaining({
        issue_id: failed,
        notification_event: "pi.needs_user"
      })]);
      expect(body.verification_gaps).toEqual([expect.objectContaining({
        code: "done_missing_verification_evidence",
        issue_id: weakDone
      })]);
      expect(body.usage_cost).toMatchObject({ status: "available", total_tokens: 15 });
      expect(body.provider_health).toMatchObject({ warnings: [] });
      expect(body.notification.channels).toMatchObject({ mobile: false, sse: true, webhook: false });
      expect(event).toMatchObject({ projectId: "demo", type: "pi.report.generated" });

      const list = await router.handle(new Request(`${BASE_URL}/api/pi/reports?project_id=demo`));
      const reports = await list.json() as Array<Record<string, unknown>>;
      expect(list.status).toBe(200);
      expect(reports[0]).toMatchObject({ id: body.report_id, project_id: "demo", type: "night_run" });

      const detail = await router.handle(new Request(`${BASE_URL}/api/pi/reports/${body.report_id}`));
      expect(detail.status).toBe(200);
      expect(await detail.json()).toMatchObject({ report_id: body.report_id, project_id: "demo" });
    } finally {
      events.close();
      database.close();
    }
  });
});

async function tempDir(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

async function request(router: ReturnType<typeof createDefaultRouter>, path: string, body: Record<string, unknown>): Promise<Response> {
  return router.handle(new Request(`${BASE_URL}${path}`, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "POST"
  }));
}

async function nextEvent(events: ReturnType<EventBus["subscribe"]>) {
  return Promise.race([
    events.next(),
    new Promise((_, reject) => setTimeout(() => reject(new Error("timed out waiting for PI report event")), 200))
  ]);
}

function insertProject(db: RunnerDatabase, id: string): void {
  db.sqlite.run(
    `insert into projects (id, name, cwd, provider, sort_order, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?)`,
    [id, id, `/tmp/${id}`, "codex", 1, "2026-06-03T09:00:00Z", "2026-06-03T09:00:00Z"]
  );
}

function insertIssue(db: RunnerDatabase, projectID: string, input: {
  codexThreadID?: string; error?: string; status: string; title: string;
}): number {
  db.sqlite.run(
    `insert into issues (project_id, title, status, error, codex_thread_id, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?)`,
    [projectID, input.title, input.status, input.error ?? "", input.codexThreadID ?? "",
      "2026-06-03T10:00:00Z", "2026-06-03T10:00:00Z"]
  );
  return db.sqlite.query<{ id: number }, []>("select last_insert_rowid() as id").get()?.id ?? 0;
}

function insertRun(db: RunnerDatabase, issueID: number, id: string, status: string, sessionID: string): void {
  db.sqlite.run(
    `insert into issue_runs
      (id, issue_id, attempt, status, provider, provider_session_id, codex_thread_id, started_at, ended_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, issueID, 1, status, "codex", sessionID, sessionID, "2026-06-03T10:00:00Z", "2026-06-03T10:20:00Z"]
  );
}

function insertSession(db: RunnerDatabase, issueID: number, sessionID: string): void {
  db.sqlite.run(
    `insert into agent_sessions
      (session_key, provider, provider_session_id, project_id, issue_id, title, status, raw_ref, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [`codex:${sessionID}`, "codex", sessionID, "demo", issueID, "Completed issue", "done", "{}",
      "2026-06-03T10:00:00Z", "2026-06-03T10:20:00Z"]
  );
}

function insertHeartbeat(db: RunnerDatabase, projectID: string, heartbeatID: string): void {
  db.sqlite.run(
    `insert into pi_heartbeat_runs (id, kind, project_id, status, started_at, finished_at, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?)`,
    [heartbeatID, "delegation", projectID, "completed", "2026-06-03T10:00:00Z", "2026-06-03T10:30:00Z",
      "2026-06-03T10:00:00Z", "2026-06-03T10:30:00Z"]
  );
}

function insertAudit(db: RunnerDatabase, projectID: string, issueID: number, actionID: string): void {
  db.sqlite.run(
    `insert into pi_action_events (action_id, project_id, issue_id, event_type, actor, reason, created_at)
     values (?, ?, ?, ?, ?, ?, ?)`,
    [actionID, projectID, issueID, "approval_decision", "user", "blocked", "2026-06-03T10:10:00Z"]
  );
}

async function writeUsage(root: string, sessionID: string, cwd: string, totalTokens: number): Promise<void> {
  const path = join(root, "2026", "06", "03", "usage.jsonl");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, [
    JSON.stringify({ type: "session_meta", payload: { cwd, id: sessionID } }),
    JSON.stringify({
      payload: { info: { last_token_usage: { total_tokens: totalTokens } }, type: "token_count" },
      timestamp: "2026-06-03T10:20:00Z",
      type: "event_msg"
    })
  ].join("\n") + "\n");
}
