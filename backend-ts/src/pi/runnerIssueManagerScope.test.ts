import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { getIssue } from "../db/repositories/issues.ts";
import { listPiActions } from "../db/repositories/pi.ts";
import { getProject, type Project } from "../db/repositories/projects.ts";
import { createPiRunnerActions } from "./runnerActions.ts";

describe("PI runner issue-manager scope", () => {
  test("can read issue summaries for any issue project", async () => {
    const fixture = await openFixture();
    try {
      insertProject(fixture.db, "other", `${fixture.project.cwd}-other`);
      const currentIssue = insertIssue(fixture.db, { projectID: fixture.project.id, status: "todo", title: "Current" });
      insertIssue(fixture.db, { projectID: "other", status: "triage", title: "Other triage" });
      insertIssue(fixture.db, { projectID: "other", status: "done", title: "Other done" });
      const actions = createPiRunnerActions(fixture.db, {
        authorization: {
          allowed_actions: ["issue.enqueue"],
          authorizedActions: [{ action_type: "issue.enqueue", issue_id: currentIssue, project_id: fixture.project.id }],
          mode: "delegated",
          scope: { runner_resource: "issues" }
        },
        project: fixture.project,
        source: "feishu_runner_chat"
      });

      const summary = actions.issueStatusSummary({ project_id: "other" }) as Record<string, unknown>;
      const list = actions.listIssues({ project_id: "other", status: "triage" }) as { items?: Array<Record<string, unknown>>; total?: number };
      const status = actions.projectStatus({ project_id: "other" }) as Record<string, unknown>;

      expect(summary).toMatchObject({ project_id: "other", status_counts: { done: 1, triage: 1 }, total: 2, unfinished_total: 1 });
      expect(list).toMatchObject({ items: [expect.objectContaining({ project_id: "other", status: "triage", title: "Other triage" })], total: 1 });
      expect(status).toMatchObject({ id: "other", issue_status_counts: { done: 1, triage: 1 }, total_issues: 2 });
      expect(listPiActions(fixture.db, { status: "completed" })).toContainEqual(expect.objectContaining({
        action_type: "issue.status_summary",
        gate_decision: "execute",
        project_id: "other"
      }));
      expect(listPiActions(fixture.db, { status: "completed" })).toContainEqual(expect.objectContaining({
        action_type: "project.status",
        gate_decision: "execute",
        project_id: "other"
      }));
    } finally {
      await fixture.close();
    }
  });

  test("rejects natural-language status repair across issue projects without deterministic mismatch", async () => {
    const fixture = await openFixture();
    try {
      insertProject(fixture.db, "other", `${fixture.project.cwd}-other`);
      const issueID = insertIssue(fixture.db, { projectID: "other", status: "triage", title: "Move me" });
      const actions = createPiRunnerActions(fixture.db, {
        authorization: issueManagerAuthorization(["issue.state_repair"]),
        project: fixture.project,
        source: "feishu_runner_chat"
      });

      expect(() => actions.createIssueStateRepairProposal({
        diagnosis_code: "user_requested_status_change",
        issue_id: issueID,
        operation: "move_status",
        rationale: "用户要求标记完成"
      })).toThrow(/diagnosis .* is not current/i);

      expect(getIssue(fixture.db, issueID)).toMatchObject({ project_id: "other", status: "triage" });
      expect(listPiActions(fixture.db, { status: "completed" })).not.toContainEqual(expect.objectContaining({
        action_type: "issue.state_repair",
        issue_id: issueID
      }));
    } finally {
      await fixture.close();
    }
  });

  test("can enqueue and request a PI decision across issue projects without switching context", async () => {
    const fixture = await openFixture();
    const kicked: string[] = [];
    try {
      insertProject(fixture.db, "other", `${fixture.project.cwd}-other`, true);
      const otherIssue = insertIssue(fixture.db, { projectID: "other", status: "triage", title: "Other runnable" });
      const ended = insertIssue(fixture.db, { projectID: "other", status: "in_progress", title: "Other ended run" });
      fixture.db.sqlite.run(`insert into issue_runs
        (id, issue_id, attempt, status, provider, started_at, ended_at, exit_reason)
        values (?, ?, 1, 'done', 'codex', ?, ?, 'completed')`, [
        `run-${ended}`, ended, "2026-06-10T06:00:00Z", "2026-06-10T06:05:00Z"
      ]);
      const actions = createPiRunnerActions(fixture.db, {
        authorization: issueManagerAuthorization(["issue.create", "issue.enqueue", "issue.schedule_enqueue", "issue.state_repair"]),
        onIssueEnqueued: (projectID) => kicked.push(projectID),
        project: fixture.project,
        source: "feishu_runner_chat"
      });

      const enqueue = actions.enqueueIssueProposal({ issue_id: otherIssue, rationale: "跨 issue project 入队" }) as { decision: string; status: string };
      const repair = actions.createIssueStateRepairProposal({
        diagnosis_code: "in_progress_session_ended",
        issue_id: ended,
        operation: "request_pi_decision",
        rationale: "请求 PI 判断已结束的 Run"
      }) as { decision: string; status: string };

      expect(enqueue).toMatchObject({ decision: "execute", status: "completed" });
      expect(repair).toMatchObject({ decision: "execute", status: "completed" });
      expect(getIssue(fixture.db, otherIssue)).toMatchObject({ project_id: "other", status: "todo" });
      expect(getIssue(fixture.db, ended)).toMatchObject({ project_id: "other", status: "in_progress" });
      expect(kicked).toEqual(["other"]);
    } finally {
      await fixture.close();
    }
  });
});

function issueManagerAuthorization(actions: string[]) {
  return {
    allowed_actions: actions,
    authorizedActions: actions.map((action_type) => ({ action_type })),
    mode: "delegated" as const,
    scope: { runner_resource: "issues" }
  };
}

async function openFixture(): Promise<{ close(): Promise<void>; db: RunnerDatabase; project: Project }> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-bun-pi-issue-manager-scope-"));
  const db = await openDatabase({ stateDir: join(root, "state") });
  insertProject(db, "demo", join(root, "project"));
  const project = getProject(db, "demo");
  if (!project) throw new Error("missing fixture project");
  return { db, project, close: async () => { db.close(); await rm(root, { recursive: true, force: true }); } };
}

function insertProject(db: RunnerDatabase, id: string, cwd: string, executable = false): void {
  const columns = executable ? ", provider, provider_config_json" : "";
  const values = executable ? ", ?, ?" : "";
  const params = executable ? ["codex", '{"capabilities":["issue_execution"]}'] : [];
  db.sqlite.run(
    `insert into projects (id, name, cwd${columns}, sort_order, created_at, updated_at)
     values (?, ?, ?${values}, ?, ?, ?)`,
    [id, id, cwd, ...params, 1, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
}

function insertIssue(
  db: RunnerDatabase,
  input: { projectID: string; status: string; title: string }
): number {
  db.sqlite.run(
    `insert into issues (project_id, title, status, created_at, updated_at) values (?, ?, ?, ?, ?)`,
    [input.projectID, input.title, input.status, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
  const row = db.sqlite.query<{ id: number }, []>("select last_insert_rowid() as id").get();
  if (!row) throw new Error("missing issue id");
  return row.id;
}
