import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildConfig } from "../config/env.ts";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
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
  test("generates a manual report with evidence links, escalation, verification gap, and usage", async () => {
    const root = await tempDir("codex-runner-pi-reports-api-");
    const database = await openDatabase({ stateDir: join(root, "state") });
    const sessionsDir = join(root, "sessions");
    try {
      insertProject(database, "demo");
      const done = insertIssue(database, "demo", {
        codexThreadID: "thread-done",
        error: "bun test passed",
        status: "done",
        title: "Completed issue"
      });
      const failed = insertIssue(database, "demo", {
        error: "approval denied; API_KEY=secret-value; /Users/xiaobei/private.txt; waiting for user input",
        status: "failed",
        title: "Needs user"
      });
      const weakDone = insertIssue(database, "demo", { status: "done", title: "Weak done" });
      insertRun(database, done, "issue-done-attempt-1", "done", "thread-done");
      insertSession(database, done, "thread-done");
      insertHeartbeat(database, "demo", "hb-1");
      insertAudit(database, "demo", failed, "act-1");
      insertSupervisorEvent(database, done, "action", {
        actionType: "session.resume_followup",
        decision: "resume_session"
      });
      insertSupervisorEvent(database, failed, "action", {
        actionType: "issue.retry_after",
        decision: "wait",
        retryAfterAt: "2026-06-03T11:00:00Z"
      });
      insertSupervisorEvent(database, failed, "decision", {
        diagnosisCode: "session_recovery_exhausted",
        decision: "needs_user"
      });
      await writeUsage(sessionsDir, "thread-done", "/tmp/demo", 15);

      const router = createDefaultRouter({ codexSessionsDir: sessionsDir, database });
      const response = await request(router, "/api/pi/reports/generate", {
        project_id: "demo",
        since: "2026-06-03T00:00:00Z",
        type: "night_run",
        until: "2026-06-04T00:00:00Z"
      });
      const body = await response.json() as Record<string, any>;

      expect(response.status).toBe(201);
      expect(body).toMatchObject({
        project_id: "demo",
        source: "manual",
        status: "generated",
        type: "night_run",
        window: { since: "2026-06-03T00:00:00Z", until: "2026-06-04T00:00:00Z" }
      });
      expect(body.completed_issues).toEqual([
        expect.objectContaining({
          evidence_links: expect.objectContaining({
            issue: `/api/issues/${done}`,
            runs: `/api/issues/${done}/runs`,
            session: "/api/sessions/codex:thread-done"
          }),
          id: done
        }),
        expect.objectContaining({
          id: weakDone
        })
      ]);
      expect(body.failed_retry_summary.failed_issues).toEqual([expect.objectContaining({
        evidence_links: expect.objectContaining({ audit: "/api/pi/audit-events?project_id=demo&issue_id=" + failed }),
        error: expect.stringContaining("[redacted]"),
        id: failed
      })]);
      expect(body.failed_retry_summary.failed_issues[0].error).not.toContain("secret-value");
      expect(body.failed_retry_summary.failed_issues[0].error).not.toContain("/Users/xiaobei");
      expect(body.issue_categories.needs_user).toEqual([expect.objectContaining({ id: failed })]);
      expect(body.summary_text_zh).toContain("夜间执行总结");
      expect(body.summary_text_zh).toContain("需用户 1");
      expect(body.blocked_escalations).toEqual([expect.objectContaining({
        issue_id: failed,
        notification_event: "pi.needs_user"
      })]);
      expect(body.verification_gaps).toEqual([]);
      expect(body.usage_cost).toMatchObject({
        events_scanned: 1,
        status: "available",
        summary: { all_time: { total_tokens: 15 } },
        total_tokens: 15
      });
      expect(body.provider_health).toMatchObject({ warnings: [] });
      expect(body.notification.channels).toMatchObject({ mobile: false, sse: true, webhook: false });
      expect(body.supervisor_summary).toMatchObject({
        exhausted_recoveries: 1,
        needs_user_escalations: 1,
        rate_limit_waits: 1,
        recovered_issues: 1,
        recovery_actions: 1
      });
      expect(body.summary).toMatchObject({
        supervisor_needs_user_escalations: 1,
        supervisor_rate_limit_waits: 1,
        supervisor_recovered_issues: 1
      });

      const list = await router.handle(new Request(`${BASE_URL}/api/pi/reports?project_id=demo`));
      const reports = await list.json() as Array<Record<string, unknown>>;
      expect(list.status).toBe(200);
      expect(reports[0]).toMatchObject({
        id: body.report_id,
        project_id: "demo",
        source: "manual",
        supervisor_summary: {
          needs_user_escalations: 1,
          rate_limit_waits: 1,
          recovered_issues: 1
        },
        status: "generated",
        type: "night_run"
      });

      const detail = await router.handle(new Request(`${BASE_URL}/api/pi/reports/${body.report_id}`));
      expect(detail.status).toBe(200);
      expect(await detail.json()).toMatchObject({ report_id: body.report_id, project_id: "demo" });
    } finally {
      database.close();
    }
  });

  test("warns when the selected provider is unavailable without leaking provider env", async () => {
    const root = await tempDir("codex-runner-pi-reports-health-");
    const database = await openDatabase({ stateDir: join(root, "state") });
    const sessionsDir = await tempDir("codex-runner-pi-reports-empty-usage-");
    try {
      insertProject(database, "demo");
      const config = buildConfig({
        codexCommand: "missing-codex-for-pi-report",
        codexEnv: "CODEX_API_KEY=report-secret,SAFE_ENV=ok",
        stateDir: join(root, "runtime")
      });
      const router = createDefaultRouter({ codexSessionsDir: sessionsDir, config, database });

      const response = await request(router, "/api/pi/reports/generate", {
        project_id: "demo",
        since: "2026-06-03T00:00:00Z",
        until: "2026-06-04T00:00:00Z"
      });
      const text = await response.text();
      const body = JSON.parse(text) as Record<string, any>;

      expect(response.status).toBe(201);
      expect(body.provider_health).toMatchObject({
        available: false,
        provider: "codex",
        status: "warning"
      });
      expect(body.provider_health.warnings).toEqual([expect.objectContaining({
        code: "provider_unavailable"
      })]);
      expect(body.warnings).toEqual([expect.objectContaining({
        code: "provider_unavailable"
      })]);
      expect(text).not.toContain("report-secret");
      expect(text).not.toContain("CODEX_API_KEY");
      expect(text).not.toContain("SAFE_ENV");
      expect(text).not.toContain("missing-codex-for-pi-report");
    } finally {
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

function insertSupervisorEvent(db: RunnerDatabase, issueID: number, eventType: string, input: {
  actionType?: string; decision?: string; diagnosisCode?: string; retryAfterAt?: string;
}): void {
  db.sqlite.run(
    `insert into issue_supervisor_events
      (issue_id, project_id, event_type, diagnosis_code, decision, action_type, retry_after_at, payload_json, created_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [issueID, "demo", eventType, input.diagnosisCode ?? "", input.decision ?? "",
      input.actionType ?? "", input.retryAfterAt ?? "", "{}", "2026-06-03T10:12:00Z"]
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
