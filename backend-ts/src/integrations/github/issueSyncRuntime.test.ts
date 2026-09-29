import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase, type RunnerDatabase } from "../../db/database.ts";
import { getIssue } from "../../db/repositories/issues.ts";
import { buildGitHubConnectorConfig } from "./config.ts";
import { GitHubIssueClient } from "./issueClient.ts";
import { GitHubIssueSyncRuntime } from "./issueSyncRuntime.ts";
import { claimGitHubWrite, finishGitHubWrite, getGitHubIssueCase, observeGitHubIssue, queueGitHubWrite, type GitHubIssueSource } from "./issueCaseStore.ts";
import { syncGitHubHumanReview } from "./issueHumanBridge.ts";
import { createHumanReviewRequest } from "../../domain/review/humanReview.ts";

const roots: string[] = [];
const databases: RunnerDatabase[] = [];
afterEach(async () => { for (const db of databases.splice(0)) db.close(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "xuanwu-github-sync-")); roots.push(root);
  const db = await openDatabase({ dbPath: join(root, "runner.db") }); databases.push(db);
  db.sqlite.run("insert into projects (id, name, cwd, created_at, updated_at) values ('demo','Demo',?,'2026-09-26T00:00:00Z','2026-09-26T00:00:00Z')", [root]);
  const repository = { id: 123, full_name: "acme/demo", default_branch: "main" };
  const remote = { node_id: "I_test1", id: 10, number: 1, title: "A reproducible bug", body: "Expected 5, observed -1", state: "open",
    state_reason: null, updated_at: "2026-09-26T01:00:00Z", html_url: "https://github.com/acme/demo/issues/1", labels: [{ name: "xuanwu" }], user: { login: "reporter" } };
  const comments: Array<Record<string, unknown>> = [];
  const requests: Array<{ path: string; method: string }> = [];
  let loseNextCommentResponse = false;
  let permission = "write";
  const client = new GitHubIssueClient({ apiBaseUrl: "https://api.github.com", token: async () => "test-github-sync-credential", fetch: async (input, init) => {
    const url = new URL(String(input)); const path = url.pathname; const method = init?.method ?? "GET";
    requests.push({ path, method });
    if (path.endsWith("/permission")) return Response.json({ permission });
    if (path === "/repos/acme/demo") return Response.json(repository);
    if (path === "/repos/acme/demo/issues") return Response.json([remote]);
    if (path === "/repos/acme/demo/issues/1") return Response.json(remote);
    if (path === "/repos/acme/demo/issues/1/comments") {
      if (method === "GET") return Response.json(comments);
      const comment = { id: comments.length + 1, user: { login: "xuanwu-test-bot" }, body: JSON.parse(String(init?.body)).body, html_url: "https://github.com/acme/demo/issues/1#issuecomment-1" };
      comments.push(comment);
      if (loseNextCommentResponse) { loseNextCommentResponse = false; throw new Error("connection lost after write"); }
      return Response.json(comment, { status: 201 });
    }
    if (path.startsWith("/repos/acme/demo/issues/comments/") && method === "PATCH") {
      const row = comments.find(item => item.id === Number(path.split("/").at(-1)))!;
      row.body = JSON.parse(String(init?.body)).body;
      return Response.json(row);
    }
    throw new Error(`Unexpected request: ${method} ${path}`);
  } });
  const config = buildGitHubConnectorConfig({ issueSync: { enabled: true, repositories: [{ repository: "acme/demo", projectId: "demo", autoEnqueue: false }] } });
  let time = new Date("2026-09-26T02:00:00Z");
  const runtime = () => new GitHubIssueSyncRuntime({ config, stateDir: root, runtime: { database: db }, client,
    actorLogin: async () => "xuanwu-test-bot", now: () => time });
  return { db, root, remote, comments, requests, config, client, runtime, advance: () => { time = new Date(time.getTime() + 180000); },
    loseResponse: () => { loseNextCommentResponse = true; }, permission: (value: string) => { permission = value; } };
}

test("GitHub polling creates one canonical triage Work and one progress comment across restart", async () => {
  const f = await fixture();
  await f.runtime().sync();
  const record = getGitHubIssueCase(f.db, "I_test1")!;
  expect(record.stage).toBe("investigate");
  expect(getIssue(f.db, record.issue_id!)?.status).toBe("triage");
  expect(getIssue(f.db, record.issue_id!)?.description).toContain("XUANWU_GITHUB_REPORT:");
  expect(f.comments).toHaveLength(1);
  await f.runtime().sync();
  expect(f.db.sqlite.query("select count(*) as n from issues").get()).toEqual({ n: 1 });
  expect(f.comments).toHaveLength(1);
  expect(f.db.sqlite.query("select count(*) as n from external_events").get()).toEqual({ n: 1 });
});

test("lost GitHub write response is recovered by durable marker without duplicate comment", async () => {
  const f = await fixture(); f.loseResponse();
  await f.runtime().sync();
  expect(f.comments).toHaveLength(1);
  expect(f.db.sqlite.query("select status from sync_outbox where operation_kind='github_issue'").get()).toEqual({ status: "retry" });
  f.advance(); await f.runtime().sync();
  expect(f.comments).toHaveLength(1);
  expect(f.db.sqlite.query("select status from sync_outbox where operation_kind='github_issue'").get()).toEqual({ status: "sent" });
});

test("a paginated scan never treats its first-page ETag as a whole-repository checkpoint", async () => {
  const f = await fixture();
  const original = f.client.page.bind(f.client);
  const etags: string[] = [];
  f.client.page = (async (path: string, etag = "") => {
    if (path.startsWith("/repos/acme/demo/issues?")) {
      etags.push(etag);
      return { items: [f.remote], next: "/next-issue-page", etag: '"first-page-only"', notModified: false };
    }
    if (path === "/next-issue-page") return { items: [], next: null, etag: "", notModified: false };
    return original(path, etag);
  }) as typeof f.client.page;
  await f.runtime().sync(); await f.runtime().sync(); await f.runtime().sync();
  expect(etags).toEqual(["", "", ""]);
});

test("remote close cancels pending Work without claiming a fix and reopen starts fresh investigation", async () => {
  const f = await fixture(); await f.runtime().sync();
  const initial = getGitHubIssueCase(f.db, "I_test1")!;
  f.remote.state = "closed"; f.remote.updated_at = "2026-09-26T03:00:00Z";
  await f.runtime().sync();
  expect(getIssue(f.db, initial.issue_id!)?.status).toBe("cancelled");
  const source = JSON.parse(getGitHubIssueCase(f.db, "I_test1")!.source_json) as GitHubIssueSource;
  const result = observeGitHubIssue(f.db, { ...source, state: "open", body: "outdated", updatedAt: "2026-09-26T00:00:00.000Z" }, "demo");
  expect(result.stale).toBe(true);
  expect(result.record.external_state).toBe("closed");
  expect(f.db.sqlite.query("select count(*) as n from external_events where source='github'").get()).toEqual({ n: 2 });
  f.remote.state = "open"; f.remote.updated_at = "2026-09-26T04:00:00Z";
  await f.runtime().sync();
  const reopened = getGitHubIssueCase(f.db, "I_test1")!;
  expect(reopened.source_revision).toBe(2);
  expect(reopened.issue_id).not.toBe(initial.issue_id);
  expect(reopened.stage).toBe("investigate");
});

test("source edits preserve active Work and restart investigation after that Work ends", async () => {
  const f = await fixture(); await f.runtime().sync();
  const first = getGitHubIssueCase(f.db, "I_test1")!;
  f.db.sqlite.run("update issues set status='in_progress' where id=?", [first.issue_id!]);
  f.remote.body = "Updated expected behavior"; f.remote.updated_at = "2026-09-26T03:00:00Z";
  await f.runtime().sync();
  expect(getGitHubIssueCase(f.db, "I_test1")).toMatchObject({ source_revision: 2, work_source_revision: 1, issue_id: first.issue_id });
  f.db.sqlite.run("update issues set status='cancelled' where id=?", [first.issue_id!]);
  await f.runtime().sync();
  const second = getGitHubIssueCase(f.db, "I_test1")!;
  expect(second.issue_id).not.toBe(first.issue_id);
  expect(second.work_source_revision).toBe(2);
});

test("expired outbox lease cannot overwrite the next worker's receipt", async () => {
  const f = await fixture(); await f.runtime().sync();
  const record = getGitHubIssueCase(f.db, "I_test1")!;
  queueGitHubWrite(f.db, record, { kind: "comment", repository: record.repository, issueNumber: 1, issueNodeId: record.issue_node_id, sourceRevision: 1, body: "test" }, "lease-test");
  const first = claimGitHubWrite(f.db, record.repository, new Date("2026-09-26T04:00:00Z"))!;
  expect(claimGitHubWrite(f.db, record.repository, new Date("2026-09-26T04:01:00Z"))).toBeNull();
  const second = claimGitHubWrite(f.db, record.repository, new Date("2026-09-26T04:03:00Z"))!;
  expect(finishGitHubWrite(f.db, first, { receipt: { id: "stale" } })).toBe(false);
  expect(finishGitHubWrite(f.db, second, { receipt: { id: "valid" } })).toBe(true);
});

test("human reply checks request revision and current repository permission", async () => {
  const f = await fixture(); await f.runtime().sync();
  const record = getGitHubIssueCase(f.db, "I_test1")!;
  f.db.sqlite.run("update issues set status='needs_user' where id=?", [record.issue_id!]);
  const review = createHumanReviewRequest(f.db, record.issue_id!, { kind: "decision", question: "预期应为多少？" });
  const comment = (id: number, revision: number) => ({ id, user: { login: "reporter", type: "User" }, body: `/xuanwu answer ${review.id} ${revision} 应为 5`, created_at: new Date(Date.now() + 1000).toISOString() });
  f.comments.push(comment(10, review.revision - 1));
  await syncGitHubHumanReview({ database: f.db, client: f.client, record, actorLogin: "xuanwu-test-bot" });
  expect(getIssue(f.db, record.issue_id!)?.status).toBe("needs_user");
  f.permission("read"); f.comments.push(comment(11, review.revision));
  await syncGitHubHumanReview({ database: f.db, client: f.client, record: getGitHubIssueCase(f.db, "I_test1")!, actorLogin: "xuanwu-test-bot" });
  expect(getIssue(f.db, record.issue_id!)?.status).toBe("needs_user");
  expect(f.db.sqlite.query("select action from tracker_sync_events where action='github.unauthorized_human_reply'").get()).toBeTruthy();
});

test("configuration reload rejects an active poll without stopping it and applies after it settles", async () => {
  const f = await fixture();
  let release!: () => void;
  const identity = new Promise<void>(resolve => { release = resolve; });
  const runtime = new GitHubIssueSyncRuntime({ config: f.config, stateDir: f.root, runtime: { database: f.db }, client: f.client,
    actorLogin: async () => { await identity; return "fixture-bot"; } });
  const running = runtime.sync();
  const disabled = { ...f.config, issueSync: { ...f.config.issueSync, enabled: false } };
  expect(() => runtime.reload(disabled)).toThrow("busy");
  expect(runtime.configuration().enabled).toBe(true);
  release();
  await running;
  expect(getGitHubIssueCase(f.db, "I_test1")?.stage).toBe("investigate");
  runtime.reload(disabled);
  expect(runtime.configuration().enabled).toBe(false);
  const count = f.requests.length;
  await runtime.sync();
  expect(f.requests.length).toBe(count);
  await runtime.stop();
  expect(() => runtime.reload(f.config)).toThrow("stopped");
});

test("changing intake label scans the new range without the previous label watermark", async () => {
  const f = await fixture();
  const queries: URL[] = [];
  const client = new GitHubIssueClient({ apiBaseUrl: "https://api.github.com", token: async () => "fixture-token", fetch: async input => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/issues")) { queries.push(url); return Response.json([]); }
    return Response.json({ id: 123, full_name: "acme/demo" });
  } });
  f.db.sqlite.run("insert into tracker_sync_cursors (provider, scope, position, updated_at) values ('github', 'issue-sync:acme/demo', ?, ?)",
    [JSON.stringify({ repositoryId: 123, since: "2026-09-26T01:00:00Z", query: "/repos/acme/demo/issues?labels=old", etag: "old-etag" }), new Date().toISOString()]);
  const runtime = new GitHubIssueSyncRuntime({ config: f.config, stateDir: f.root, runtime: { database: f.db }, client, actorLogin: async () => "fixture-bot" });
  await runtime.sync();
  expect(queries).toHaveLength(1);
  expect(queries[0]!.searchParams.get("labels")).toBe("xuanwu");
  expect(queries[0]!.searchParams.has("since")).toBe(false);
  await runtime.stop();
});
