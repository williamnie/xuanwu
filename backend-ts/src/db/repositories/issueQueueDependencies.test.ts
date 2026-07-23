import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../database.ts";
import { getIssueAsWork, issueIDToWorkID } from "../../domain/work/issueAdapter.ts";
import { readIssueDependency } from "../../domain/work/issueDependency.ts";
import type { DependencyRelation } from "../../domain/work/contracts.ts";
import { deleteIssue } from "./issueActions.ts";
import { createIssue } from "./issueCreate.ts";
import { claimNextIssue } from "./issueQueue.ts";
import { getIssue, listIssueRuns } from "./issues.ts";
import { insertWorkRecord, insertWorkRelationRecord } from "./workLedger.ts";

const NOW = "2026-07-20T00:00:00Z";
const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) {
    const path = tempRoots.pop();
    if (path) await rm(path, { force: true, recursive: true });
  }
});

describe("issue queue Work dependency readiness", () => {
  test("materializes Markdown and structured Issue dependencies atomically before queue claim", async () => {
    const db = await fixtureDatabase();
    try {
      insertProject(db, "demo");
      const upstream = createIssue(db, { project_id: "demo", status: "todo", title: "upstream" });
      const markdown = createIssue(db, {
        description: `## 依赖\n\n- Issue #${upstream.id}：必须先完成`,
        project_id: "demo",
        status: "todo",
        title: "markdown downstream"
      });
      const structured = createIssue(db, {
        depends_on_issue_ids: [upstream.id],
        project_id: "demo",
        status: "todo",
        title: "structured downstream"
      });

      expect(readIssueDependency(db, markdown.id)).toMatchObject({
        direct_dependencies: [{ issue_id: upstream.id }],
        ready: false,
        reason: "waiting_dependency"
      });
      expect(readIssueDependency(db, structured.id)).toMatchObject({
        direct_dependencies: [{ issue_id: upstream.id }],
        ready: false,
        reason: "waiting_dependency"
      });
      expect(db.sqlite.query<{ count: number }, []>(
        "select count(*) as count from work_relations where kind='depends_on'"
      ).get()?.count).toBe(2);
      expect(claimNextIssue(db, "demo")).toMatchObject({ id: upstream.id });
      expectUntouched(db, markdown.id);
      expectUntouched(db, structured.id);
    } finally {
      db.close();
    }
  });

  test("rejects unresolved declarations and fails closed when a declared relation is missing", async () => {
    const db = await fixtureDatabase();
    try {
      insertProject(db, "demo");
      expect(() => createIssue(db, {
        description: "## 依赖\n\n- 等后端任务完成",
        project_id: "demo",
        status: "todo",
        title: "unparseable"
      })).toThrow("没有可解析");
      expect(() => createIssue(db, {
        depends_on_issue_ids: [999999],
        project_id: "demo",
        status: "todo",
        title: "missing"
      })).toThrow("不存在");

      const upstream = insertIssue(db, "upstream", "todo");
      const downstream = insertIssue(db, "downstream", "todo", 100);
      db.sqlite.run(
        "update issues set dependency_issue_ids_json=? where id=?",
        [JSON.stringify([upstream]), downstream]
      );
      expect(readIssueDependency(db, downstream)).toMatchObject({
        ready: false,
        reason: "missing_dependency",
        root_blockers: [{ issue_id: upstream, status: "missing" }]
      });
      expect(claimNextIssue(db, "demo")).toMatchObject({ id: upstream });
      expectUntouched(db, downstream);
    } finally {
      db.close();
    }
  });

  test("deleting an upstream Issue removes its structural edge and keeps downstream work fail-closed", async () => {
    const db = await fixtureDatabase();
    try {
      insertProject(db, "demo");
      const upstream = createIssue(db, {
        project_id: "demo",
        status: "cancelled",
        title: "deletable upstream"
      });
      const downstream = createIssue(db, {
        depends_on_issue_ids: [upstream.id],
        project_id: "demo",
        status: "todo",
        title: "blocked downstream"
      });

      deleteIssue(db, upstream.id);

      expect(db.sqlite.query("select id from works where id=?").get(issueIDToWorkID(upstream.id))).toBeNull();
      expect(db.sqlite.query<{ count: number }, []>(
        "select count(*) as count from work_relations where kind='depends_on'"
      ).get()).toEqual({ count: 0 });
      expect(readIssueDependency(db, downstream.id)).toMatchObject({
        ready: false,
        reason: "missing_dependency",
        root_blockers: [{ issue_id: upstream.id, status: "missing" }]
      });
      expect(claimNextIssue(db, "demo")).toBeNull();
    } finally {
      db.close();
    }
  });

  test("uses Issue status for every dependency state and only done is ready", async () => {
    const db = await fixtureDatabase();
    try {
      insertProject(db, "demo");
      for (const status of ["todo", "in_progress", "pending_verification", "failed", "done"] as const) {
        const upstream = insertIssue(db, `upstream-${status}`, status);
        const downstream = insertIssue(db, `downstream-${status}`, "todo");
        addDependency(db, downstream, upstream);
        const diagnostic = readIssueDependency(db, downstream);
        expect(diagnostic?.direct_dependencies).toMatchObject([{ issue_id: upstream, status }]);
        expect(diagnostic?.ready).toBe(status === "done");
        expect(diagnostic?.reason).toBe(
          status === "done" ? "ready" : status === "failed" ? "failed_dependency" : "waiting_dependency"
        );
      }
    } finally {
      db.close();
    }
  });

  test("leaves a waiting issue untouched, claims an independent sibling, then auto-readies after upstream done", async () => {
    const db = await fixtureDatabase();
    try {
      insertProject(db, "demo");
      const upstream = insertIssue(db, "upstream", "todo", 1);
      const downstream = insertIssue(db, "downstream", "todo", 100);
      const sibling = insertIssue(db, "independent sibling", "todo", 10);
      addDependency(db, downstream, upstream);

      expect(claimNextIssue(db, "demo")).toMatchObject({ id: sibling, status: "in_progress" });
      expectUntouched(db, downstream);

      closeIssue(db, sibling);
      db.sqlite.run("update issues set status='done', updated_at=? where id=?", [NOW, upstream]);
      expect(claimNextIssue(db, "demo")).toMatchObject({ id: downstream, status: "in_progress" });
      expect(getIssue(db, downstream)).toMatchObject({ attempt_count: 1 });
      expect(listIssueRuns(db, downstream)).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  test("deduplicates a diamond root blocker and readies the diamond when both direct dependencies are done", async () => {
    const db = await fixtureDatabase();
    try {
      insertProject(db, "demo");
      const root = insertIssue(db, "root", "todo");
      const left = insertIssue(db, "left", "todo");
      const right = insertIssue(db, "right", "todo");
      const leaf = insertIssue(db, "leaf", "todo");
      addDependency(db, left, root);
      addDependency(db, right, root);
      addDependency(db, leaf, left);
      addDependency(db, leaf, right);

      expect(readIssueDependency(db, leaf)).toMatchObject({
        ready: false,
        reason: "waiting_dependency",
        direct_dependencies: [{ issue_id: left }, { issue_id: right }],
        root_blockers: [{ issue_id: root }]
      });

      db.sqlite.run("update issues set status='done', updated_at=? where id in (?, ?, ?)", [NOW, root, left, right]);
      expect(readIssueDependency(db, leaf)).toMatchObject({ ready: true, reason: "ready", root_blockers: [] });
    } finally {
      db.close();
    }
  });

  test("fails closed for missing references and cycles without creating attempts or Runs", async () => {
    const db = await fixtureDatabase();
    try {
      insertProject(db, "demo");
      const missingUpstream = insertIssue(db, "deleted upstream", "todo");
      const missingBlocked = insertIssue(db, "missing blocked", "todo", 100);
      addDependency(db, missingBlocked, missingUpstream);
      db.sqlite.run("delete from issues where id=?", [missingUpstream]);

      const cycleA = insertIssue(db, "cycle A", "todo", 90);
      const cycleB = insertIssue(db, "cycle B", "todo", 80);
      addDependency(db, cycleA, cycleB);
      addDependency(db, cycleB, cycleA);
      const sibling = insertIssue(db, "ready sibling", "todo", 1);

      expect(readIssueDependency(db, missingBlocked)).toMatchObject({
        ready: false,
        reason: "missing_dependency",
        root_blockers: [{ issue_id: missingUpstream, status: "missing" }]
      });
      expect(readIssueDependency(db, cycleA)).toMatchObject({
        ready: false,
        reason: "dependency_cycle"
      });
      expect(claimNextIssue(db, "demo")).toMatchObject({ id: sibling });
      expectUntouched(db, missingBlocked);
      expectUntouched(db, cycleA);
      expectUntouched(db, cycleB);
    } finally {
      db.close();
    }
  });
});

async function fixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-dependency-queue-"));
  tempRoots.push(root);
  return openDatabase({ stateDir: join(root, "state") });
}

function insertProject(db: RunnerDatabase, id: string): void {
  db.sqlite.run(`insert into projects (id, name, cwd, provider, auto_run, created_at, updated_at)
    values (?, ?, ?, 'codex', 1, ?, ?)`, [id, id, `/tmp/${id}`, NOW, NOW]);
}

function insertIssue(db: RunnerDatabase, title: string, status: string, priority = 0): number {
  return createIssue(db, { project_id: "demo", priority, status, title }).id;
}

function addDependency(db: RunnerDatabase, issueID: number, dependencyID: number): void {
  ensureWork(db, issueID);
  ensureWork(db, dependencyID);
  const relation: DependencyRelation = {
    actor: { id: "queue-test", kind: "runner" },
    audit_event_ref: `queue-test:${issueID}:${dependencyID}`,
    correlation_id: `queue-test:${issueID}:${dependencyID}`,
    depends_on_work_id: issueIDToWorkID(dependencyID),
    kind: "depends_on",
    occurred_at: NOW,
    reason: "queue dependency fixture",
    relation_id: `depends-on:${issueID}:${dependencyID}`,
    work_id: issueIDToWorkID(issueID)
  };
  insertWorkRelationRecord(db, "demo", relation);
}

function ensureWork(db: RunnerDatabase, issueID: number): void {
  const work = getIssueAsWork(db, issueID);
  if (!work) throw new Error(`missing fixture issue ${issueID}`);
  const exists = db.sqlite.query<{ count: number }, [string]>(
    "select count(*) as count from works where id=?"
  ).get(work.id)?.count ?? 0;
  if (exists === 0) insertWorkRecord(db, work);
}

function closeIssue(db: RunnerDatabase, issueID: number): void {
  db.sqlite.run("update issues set status='done', updated_at=? where id=?", [NOW, issueID]);
  db.sqlite.run("update issue_runs set status='done', ended_at=? where issue_id=? and ended_at=''", [NOW, issueID]);
}

function expectUntouched(db: RunnerDatabase, issueID: number): void {
  expect(getIssue(db, issueID)).toMatchObject({ status: "todo", attempt_count: 0 });
  expect(listIssueRuns(db, issueID)).toEqual([]);
}
