import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../database.ts";
import { createIssue } from "./issueCreate.ts";
import { getIssue } from "./issues.ts";
import { updateIssue } from "./issueUpdate.ts";

const roots: string[] = [];

afterEach(async () => {
  while (roots.length > 0) await rm(roots.pop()!, { force: true, recursive: true });
});

describe("unstarted Issue planning metadata updates", () => {
  test("atomically replaces and clears dependencies while replay is a no-op", async () => {
    const db = await fixtureDatabase();
    try {
      seedProject(db, "demo");
      const upstream = createIssue(db, { project_id: "demo", status: "todo", title: "Upstream" });
      const issue = createIssue(db, { description: "Before", project_id: "demo", status: "triage", title: "Before" });

      const first = updateIssue(db, issue.id, {
        depends_on_issue_ids: [upstream.id],
        description: `After\n\n## Dependencies\n\n- Issue #${upstream.id}`,
        title: "After"
      });
      const firstEvents = planningEvents(db, issue.id);
      const replay = updateIssue(db, issue.id, {
        depends_on_issue_ids: [upstream.id],
        description: `After\n\n## Dependencies\n\n- Issue #${upstream.id}`,
        title: "After"
      });

      expect(first).toMatchObject({ description: expect.stringContaining("## Dependencies"), title: "After" });
      expect(dependencyJSON(db, issue.id)).toBe(JSON.stringify([upstream.id]));
      expect(relationTargets(db, issue.id)).toEqual([workID(upstream.id)]);
      expect(firstEvents).toHaveLength(1);
      expect(JSON.parse(firstEvents[0]!.payload)).toEqual({
        contract: "unstarted-issue-planning-update-v1",
        depends_on_issue_ids: [upstream.id],
        fields: ["title", "description", "depends_on_issue_ids"]
      });
      expect(replay.updated_at).toBe(first.updated_at);
      expect(planningEvents(db, issue.id)).toEqual(firstEvents);

      updateIssue(db, issue.id, { depends_on_issue_ids: [], description: "After without dependencies" });
      expect(dependencyJSON(db, issue.id)).toBe("[]");
      expect(relationTargets(db, issue.id)).toEqual([]);
    } finally {
      db.close();
    }
  });

  test("rejects invalid dependency sets and rolls back every requested field", async () => {
    const db = await fixtureDatabase();
    try {
      seedProject(db, "demo");
      seedProject(db, "other");
      const issue = createIssue(db, { description: "Original", project_id: "demo", status: "todo", title: "Original" });
      const foreign = createIssue(db, { project_id: "other", status: "todo", title: "Foreign" });

      expect(() => updateIssue(db, issue.id, {
        depends_on_issue_ids: [foreign.id], description: "Must roll back", title: "Must roll back"
      })).toThrow(`依赖 Issue #${foreign.id} 不属于项目 demo`);
      expect(() => updateIssue(db, issue.id, { depends_on_issue_ids: [issue.id] })).toThrow("不能依赖自身");
      expect(() => updateIssue(db, issue.id, { depends_on_issue_ids: [foreign.id, foreign.id] })).toThrow("不能重复包含");
      expect(() => updateIssue(db, issue.id, { depends_on_issue_ids: [999999] })).toThrow("不存在");

      expect(getIssue(db, issue.id)).toMatchObject({ description: "Original", title: "Original" });
      expect(dependencyJSON(db, issue.id)).toBe("[]");
      expect(relationTargets(db, issue.id)).toEqual([]);
      expect(planningEvents(db, issue.id)).toEqual([]);
    } finally {
      db.close();
    }
  });

  test("rejects cycles and dependency declarations that disagree with hard edges", async () => {
    const db = await fixtureDatabase();
    try {
      seedProject(db, "demo");
      const first = createIssue(db, { project_id: "demo", status: "triage", title: "First" });
      const second = createIssue(db, {
        depends_on_issue_ids: [first.id], project_id: "demo", status: "triage", title: "Second"
      });

      expect(() => updateIssue(db, first.id, { depends_on_issue_ids: [second.id] })).toThrow("会形成依赖环");
      expect(() => updateIssue(db, second.id, { description: "## Dependencies\n\nNone" })).toThrow(
        "正文依赖章节必须与 depends_on_issue_ids 完全一致"
      );
      expect(() => createIssue(db, {
        depends_on_issue_ids: [first.id],
        description: "## Dependencies\n\nNone",
        project_id: "demo",
        status: "triage",
        title: "Mismatched create"
      })).toThrow("正文依赖章节必须与 depends_on_issue_ids 完全一致");
      expect(dependencyJSON(db, first.id)).toBe("[]");
      expect(relationTargets(db, first.id)).toEqual([]);
      expect(dependencyJSON(db, second.id)).toBe(JSON.stringify([first.id]));
      expect(relationTargets(db, second.id)).toEqual([workID(first.id)]);
    } finally {
      db.close();
    }
  });

  test("requires an explicit dependency payload to repair snapshot and relation drift", async () => {
    const db = await fixtureDatabase();
    try {
      seedProject(db, "demo");
      const upstream = createIssue(db, { project_id: "demo", status: "triage", title: "Upstream" });
      const description = `Body\n\n## Dependencies\n\n- Issue #${upstream.id}`;
      const issue = createIssue(db, {
        depends_on_issue_ids: [upstream.id], description, project_id: "demo", status: "triage", title: "Drift"
      });
      db.sqlite.run("delete from work_relations where kind='depends_on' and source_work_id=?", [workID(issue.id)]);

      expect(() => updateIssue(db, issue.id, { description: `${description}\n` })).toThrow(
        "现有结构化依赖快照与硬依赖边不一致"
      );
      updateIssue(db, issue.id, { depends_on_issue_ids: [upstream.id], description });

      expect(dependencyJSON(db, issue.id)).toBe(JSON.stringify([upstream.id]));
      expect(relationTargets(db, issue.id)).toEqual([workID(upstream.id)]);
    } finally {
      db.close();
    }
  });

  test("allows only triage or todo Issues with no Run history", async () => {
    const db = await fixtureDatabase();
    try {
      seedProject(db, "demo");
      for (const status of ["in_progress", "needs_user", "done", "failed", "cancelled"]) {
        const issue = createIssue(db, { project_id: "demo", status, title: status });
        expect(() => updateIssue(db, issue.id, { title: `${status} changed` })).toThrow(
          "只能在未开始的 triage 或 todo Issue 上更新"
        );
      }
      for (const status of ["triage", "todo"] as const) {
        const issue = createIssue(db, { project_id: "demo", status, title: `${status} ran` });
        insertEndedRun(db, issue.id);
        expect(() => updateIssue(db, issue.id, { description: "Changed after Run" })).toThrow(
          "Issue 已存在 Run 历史"
        );
      }
      const triage = createIssue(db, { project_id: "demo", status: "triage", title: "Editable triage" });
      const todo = createIssue(db, { project_id: "demo", status: "todo", title: "Editable todo" });
      const attempted = createIssue(db, { project_id: "demo", status: "todo", title: "Attempted" });
      db.sqlite.run("update issues set attempt_count=1 where id=?", [attempted.id]);
      expect(updateIssue(db, triage.id, { title: "Edited triage" }).title).toBe("Edited triage");
      expect(updateIssue(db, todo.id, { description: "Edited todo" }).description).toBe("Edited todo");
      expect(() => updateIssue(db, attempted.id, { title: "Must not change" })).toThrow("Issue 已存在 Run 历史");
    } finally {
      db.close();
    }
  });
});

async function fixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "xuanwu-issue-update-"));
  roots.push(root);
  return openDatabase({ stateDir: join(root, "state") });
}

function seedProject(db: RunnerDatabase, id: string): void {
  const timestamp = "2026-01-01T00:00:00Z";
  db.sqlite.run(
    "insert into projects (id, name, cwd, created_at, updated_at) values (?, ?, ?, ?, ?)",
    [id, id, `/tmp/${id}-${crypto.randomUUID()}`, timestamp, timestamp]
  );
}

function insertEndedRun(db: RunnerDatabase, issueID: number): void {
  db.sqlite.run(`
    insert into issue_runs (id, issue_id, attempt, status, started_at, ended_at)
    values (?, ?, 1, 'done', '2026-01-01T00:00:00Z', '2026-01-01T00:01:00Z')
  `, [`issue-${issueID}-attempt-1`, issueID]);
}

function dependencyJSON(db: RunnerDatabase, issueID: number): string {
  return db.sqlite.query<{ dependency_issue_ids_json: string }, [number]>(
    "select dependency_issue_ids_json from issues where id=?"
  ).get(issueID)!.dependency_issue_ids_json;
}

function relationTargets(db: RunnerDatabase, issueID: number): string[] {
  return db.sqlite.query<{ target_work_id: string }, [string]>(`
    select target_work_id from work_relations
    where kind='depends_on' and source_work_id=? order by target_work_id
  `).all(workID(issueID)).map((row) => row.target_work_id);
}

function planningEvents(db: RunnerDatabase, issueID: number): Array<{ payload: string }> {
  return db.sqlite.query<{ payload: string }, [number]>(`
    select payload from issue_events
    where issue_id=? and type='issue.planning_metadata_updated.v1' order by id
  `).all(issueID);
}

function workID(issueID: number): string {
  return `xw:work:issues:${issueID}`;
}
