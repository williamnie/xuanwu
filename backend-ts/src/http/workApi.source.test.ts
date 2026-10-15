import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { createIssue } from "../db/repositories/issueCreate.ts";
import { createExternalLink } from "../db/repositories/externalLinks.ts";
import { createGitHubCaseWork } from "../integrations/github/issueWorkflow.ts";
import { observeGitHubIssue, updateGitHubIssueCase } from "../integrations/github/issueCaseStore.ts";
import { buildGitHubIssueSyncConfig } from "../integrations/github/issueSyncConfig.ts";
import { createDefaultRouter } from "./server.ts";

const roots: string[] = [];
const databases: RunnerDatabase[] = [];
afterEach(async () => {
  for (const db of databases.splice(0)) db.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "xuanwu-work-source-"));
  roots.push(root);
  const db = await openDatabase({ dbPath: join(root, "test.db") });
  databases.push(db);
  for (const id of ["alpha", "beta"]) db.sqlite.run(
    "insert into projects (id,name,cwd,created_at,updated_at) values (?,?,?,'2026-10-15','2026-10-15')", [id, id, root + id]);
  const policy = buildGitHubIssueSyncConfig({ repositories: [{ repository: "acme/demo", projectId: "alpha" }] }).repositories[0]!;
  const source = { nodeId: "I_case", repositoryId: 1, repository: "acme/demo", number: 1,
    title: "Needle bug", body: "Investigate", author: "reporter", url: "https://github.com/acme/demo/issues/1",
    state: "open" as const, stateReason: "", updatedAt: "2026-10-15T00:00:00Z", labels: [] };
  let record = observeGitHubIssue(db, source, "alpha").record;
  const history: number[] = [];
  for (const stage of ["investigate", "repair", "investigate"] as const) {
    record = createGitHubCaseWork(db, record, policy, stage);
    history.push(record.issue_id!);
    db.sqlite.run("update issues set status='done' where id=?", [record.issue_id!]);
  }
  db.sqlite.run("update issues set status='failed' where id=?", [history[0]!]);
  db.sqlite.run("update issues set status='todo' where id=?", [history[2]!]);
  const manual = createIssue(db, { project_id: "alpha", title: "GitHub Needle manual task", status: "todo" });
  const bound = createIssue(db, { project_id: "beta", title: "Needle existing task", status: "todo" });
  const second = observeGitHubIssue(db, { ...source, nodeId: "I_bound", number: 2 }, "beta").record;
  updateGitHubIssueCase(db, second.issue_node_id, second.source_revision, { issue_id: bound.id });
  // Duplicate historical links must not duplicate rows; an unrelated GitHub link is not a case binding.
  createExternalLink(db, { source: "github", external_type: "github_issue", external_id: source.nodeId,
    issue_id: history[0]!, relationship: "related" });
  createExternalLink(db, { source: "github", external_type: "github_issue", external_id: "I_no_case", issue_id: manual.id });
  createExternalLink(db, { source: "github", external_type: "pull_request", external_id: source.nodeId, issue_id: manual.id });
  db.sqlite.run("update issues set updated_at='2026-10-15T00:00:00Z'");
  db.sqlite.run("pragma query_only=on");
  const router = createDefaultRouter({ database: db });
  const get = async (query: string, path = "/api/works") => {
    const response = await router.handle(new Request(`http://localhost${path}?${query}`));
    return { status: response.status, body: await response.json() as any };
  };
  return { db, get, history, manual: manual.id, bound: bound.id };
}

const ids = (body: any): number[] => body.items.map((item: any) => Number(item.id.split(":").at(-1)));

test("Work board shares source, project and keyword conditions with list totals and historical tasks", async () => {
  const f = await fixture();
  for (const source of ["github", "manual"]) {
    const query = `source=${source}&project_id=alpha&q=needle&page_size=1&status=todo&status=failed`;
    const board = await f.get(query, "/api/works/board");
    expect(board.status).toBe(200);
    expect(Object.keys(board.body.lanes).sort()).toEqual(["failed", "todo"]);
    for (const status of ["todo", "failed"]) {
      const list = await f.get(`source=${source}&project_id=alpha&q=needle&page_size=1&status=${status}`);
      expect(ids(board.body.lanes[status])).toEqual(ids(list.body));
      expect(board.body.lanes[status].total).toBe(list.body.total);
    }
  }
  const all = await f.get("", "/api/works/board");
  expect(Object.values(all.body.lanes).reduce((sum: number, lane: any) => sum + lane.total, 0)).toBe(5);
  expect((await f.get("q=no-match", "/api/works/board")).body).toEqual(all.body);
  for (const value of ["", "other", "github&source=manual"]) expect((await f.get(`source=${value}`, "/api/works/board")).status).toBe(400);
});

test("Work source includes current and historical case tasks once, with all others manual", async () => {
  const f = await fixture();
  const github = await f.get("source=github");
  expect(github.status).toBe(200);
  expect(ids(github.body).sort((a,b) => a-b)).toEqual([...f.history, f.bound]);
  expect(github.body).toMatchObject({ total: 4, filters: { source: "github" } });
  const manual = await f.get("source=manual");
  expect(ids(manual.body)).toEqual([f.manual]);
  expect(manual.body.total).toBe(1);
  expect((await f.get("")).body.total).toBe(5);
  expect(github.body.items.every((item: any) => item.provenance.origin.kind === "issue")).toBe(true);
});

test("Work source shares project, status, keyword and type conditions with counts and offset pages", async () => {
  const f = await fixture();
  const filters = "source=github&project_id=alpha&status=todo&status=failed&q=needle&type=engineering_task&page_size=1";
  const first = (await f.get(filters)).body;
  const second = (await f.get(filters + "&page=2")).body;
  expect(first).toMatchObject({ total: 2, total_pages: 2, has_more: true });
  expect(ids(first)).toEqual([f.history[2]!]);
  expect(ids(second)).toEqual([f.history[0]!]);
  expect(second).toMatchObject({ total: 2, has_more: false });
  expect(ids((await f.get("source=manual&project_id=alpha&status=todo&q=needle")).body)).toEqual([f.manual]);
  expect((await f.get("source=github&project_id=beta&status=failed&q=needle")).body.total).toBe(0);
  expect((await f.get("source=github&type=objective")).body.total).toBe(0);
});

test("Work cursors reject switching source in either direction, including the unfiltered scope", async () => {
  const f = await fixture();
  const first = (await f.get("source=github&page_size=1")).body;
  const second = (await f.get(`source=github&page_size=1&cursor=${first.next_cursor}`)).body;
  expect(second.total).toBe(4);
  expect(ids(second)).not.toEqual(ids(first));
  for (const query of ["", "source=manual&"]) {
    const result = await f.get(`${query}page_size=1&cursor=${first.next_cursor}`);
    expect(result.status).toBe(400);
    expect(result.body.code).toBe("invalid_cursor");
  }
  const all = (await f.get("page_size=1")).body;
  expect((await f.get(`source=github&page_size=1&cursor=${all.next_cursor}`)).status).toBe(400);
});

test("Work source contract rejects unknown, empty, mixed and repeated source values", async () => {
  const f = await fixture();
  for (const source of ["all", "", "GitHub", "github,manual", "github&source=manual", "github&source=github"]) {
    const result = await f.get(`source=${source}`);
    expect(result.status).toBe(400);
    expect(result.body.code).toBe("invalid_request");
  }
});

test("Work source uses bounded SQL queries and existing indexes for the count and page", async () => {
  const f = await fixture();
  const sqlite = f.db.sqlite;
  const statements: string[] = [];
  f.db.sqlite = new Proxy(sqlite, {
    get(target, key) {
      if (key === "query") return (sql: string) => {
        if (sql.includes("from github_issue_cases")) statements.push(sql);
        return target.query(sql);
      };
      return Reflect.get(target, key);
    }
  });
  try {
    await f.get("source=github&page_size=100");
  } finally { f.db.sqlite = sqlite; }
  expect(statements).toHaveLength(2);
  for (const sql of statements) {
    const plan = f.db.sqlite.query(`explain query plan ${sql}`).all(...Array((sql.match(/\?/g) || []).length).fill(0));
    const detail = JSON.stringify(plan);
    expect(detail).toContain("idx_github_issue_cases_work");
    expect(detail).toContain("idx_external_links_issue");
    expect(detail).toContain("sqlite_autoindex_github_issue_cases_1");
  }
});
