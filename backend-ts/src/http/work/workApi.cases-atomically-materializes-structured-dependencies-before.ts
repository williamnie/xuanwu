import { expect, test } from "bun:test";
import { createIssue } from "../../db/repositories/issueCreate.ts";
import { readIssueDependency } from "../../domain/work/issueDependency.ts";
import { issueIDToWorkID, workIDToIssueID } from "../../domain/work/issueAdapter.ts";
import type { TestFixture } from "./workApi.testFixture.ts";

export function registerAtomicallyMaterializesStructuredDependenciesBeforeCases(testScope: TestFixture) {
  const { work, workApi, insertWorkProject, audit, rowCount, adapterAudits } = testScope;
  test("atomically materializes structured dependencies before a todo Work can be scheduled", async () => {
      const { db, authed } = await workApi();
      const upstream = createIssue(db, { project_id: "demo", status: "todo", title: "Upstream" });
  
      const created = await authed.post("/api/works", {
        audit: audit("dependent-work-create", "supervisor"),
        depends_on_issue_ids: [upstream.id],
        goal: "Wait for upstream delivery",
        project_id: "demo",
        status: "todo",
        title: "Dependent Work",
        type: "engineering_task"
      });
  
      expect(created.status).toBe(201);
      expect(readIssueDependency(db, workIDToIssueID(String(created.body.work.id)))).toMatchObject({
        direct_dependencies: [{ issue_id: upstream.id }],
        ready: false,
        reason: "waiting_dependency"
      });
      expect(rowCount(db, "work_relations")).toBe(1);
    });
  
  test("lists, filters, sorts and pages Issue-authoritative Work without relation projections", async () => {
      const { db, api } = await workApi();
      const alpha = createIssue(db, { description: "Alpha goal", project_id: "demo", status: "triage", title: "Alpha" });
      createIssue(db, { description: "Charlie goal", project_id: "demo", status: "triage", title: "Charlie" });
      createIssue(db, { description: "Bravo goal", project_id: "demo", status: "todo", title: "Bravo" });
  
      const list = await api.get("/api/works?project_id=demo&status=triage&type=engineering_task&sort=title&order=asc&page=2&page_size=1");
      expect(list).toMatchObject({
        status: 200,
        body: { items: [{ title: "Charlie", type: "engineering_task" }], page: 2, page_size: 1, total: 2, total_pages: 2 }
      });
      expect(list.body).not.toHaveProperty("compatibility");
      expect(await api.get("/api/works?project_id=demo&q=alpha")).toMatchObject({ status: 200, body: { items: [{ title: "Alpha" }], total: 1 } });
      expect(await api.get("/api/works/board?project_id=demo&page_size=1&sort=title&order=asc")).toMatchObject({
        status: 200,
        body: {
          lanes: {
            todo: { items: [{ title: "Bravo" }], page: 1, page_size: 1, total: 1, total_pages: 1 },
            triage: { items: [{ title: "Alpha" }], page: 1, page_size: 1, total: 2, total_pages: 2 }
          },
          page_size: 1,
          project_id: "demo",
          sort: { field: "title", order: "asc" }
        }
      });
      expect(await api.get(work(alpha.id))).toMatchObject({
        status: 200,
        body: { decision: { owner: "pi", request: null }, work: { goal: "Alpha goal", id: issueIDToWorkID(alpha.id), title: "Alpha" } }
      });
      expect((await api.get("/api/work-relations")).status).toBe(404);
      expect(rowCount(db, "works")).toBe(0);
      expect(rowCount(db, "work_relations")).toBe(0);
    });
  
  test("returns bounded summary aggregates, selected board lanes, and strict updated-at cursors", async () => {
      const { db, api } = await workApi("alpha");
      insertWorkProject(db, "beta");
      const first = createIssue(db, { project_id: "alpha", status: "in_progress", title: "Guardian gate" });
      const second = createIssue(db, { project_id: "alpha", status: "done", title: "Done" });
      const pending = createIssue(db, { project_id: "beta", status: "needs_user", title: "Verify" });
      const unknown = createIssue(db, { project_id: "beta", status: "triage", title: "Unknown" });
      db.sqlite.run("update issues set status='future_status' where id=?", [unknown.id]);
      db.sqlite.run("update issues set status='pending_verification' where id=?", [pending.id]);
      db.sqlite.run("update issues set updated_at='2026-08-19T00:00:00.000Z' where id in (?, ?)", [first.id, second.id]);
  
      expect(await api.get("/api/works/summary")).toMatchObject({
        status: 200,
        body: {
          activity: { guarding: 1 },
          contract: "xuanwu.work-summary.v1",
          counts: { done: 1, history: 1, in_progress: 1, needs_user: 1, operational: 2, total: 4, unknown_status_count: 1 },
          project_count: 2,
          project_counts: expect.arrayContaining([
            expect.objectContaining({ project_id: "alpha", counts: expect.objectContaining({ total: 2 }) }),
            expect.objectContaining({ project_id: "beta", counts: expect.objectContaining({ total: 2 }) })
          ])
        }
      });
      const projectSummary = await api.get("/api/works/summary?project_id=alpha");
      expect(projectSummary).toMatchObject({ status: 200, body: { project_count: 1, scope: { project_id: "alpha" } } });
      expect(projectSummary.body).not.toHaveProperty("project_counts");
      expect(Object.keys((await api.get("/api/works/board?status=triage&status=todo")).body.lanes).sort()).toEqual(["todo", "triage"]);
      const cursorFilters = "sort=updated_at&order=desc&page_size=1&status=done&status=in_progress";
      const pageOne = (await api.get(`/api/works?${cursorFilters}`)).body;
      const pageTwo = (await api.get(`/api/works?${cursorFilters}&cursor=${pageOne.next_cursor}`)).body;
      expect(pageOne.items).toHaveLength(1);
      expect(pageTwo.items).toHaveLength(1);
      expect(pageTwo.items[0].id).not.toBe(pageOne.items[0].id);
      expect(pageTwo.total).toBe(pageOne.total);
      expect(await api.get(`/api/works?sort=updated_at&order=desc&page_size=1&status=done&cursor=${pageOne.next_cursor}`))
        .toMatchObject({ status: 400, body: { code: "invalid_cursor" } });
    });
  
  test("fails closed at the Project summary capacity without truncating global counts", async () => {
      const { db, api } = await workApi("project-0");
      for (let index = 1; index < 129; index += 1) insertWorkProject(db, `project-${index}`);
  
      expect(await api.get("/api/works/summary")).toMatchObject({ status: 409, body: { code: "project_summary_capacity_exceeded" } });
      expect(await api.get("/api/works/summary?include_projects=false")).toMatchObject({ status: 200, body: { project_count: 129 } });
    });
  
  test("creates, updates, enqueues and cancels through the Issue adapter with idempotent audit", async () => {
      const { db, authed, unauthed } = await workApi();
      const createPayload = {
        audit: audit("work-create-1", "user"),
        goal: "Ship Work API",
        project_id: "demo",
        status: "triage",
        title: "Work API",
        type: "engineering_task"
      };
  
      expect(await unauthed.post("/api/works", createPayload)).toMatchObject({ status: 401, body: { message: "unauthorized" } });
      const created = await authed.post("/api/works", createPayload);
      expect((await authed.post("/api/works", createPayload)).status).toBe(201);
      expect(await authed.post("/api/works", { ...createPayload, title: "Conflicting replay" })).toEqual(expect.objectContaining({
        status: 409,
        body: { code: "work_event_conflict", message: "Work audit event conflicts with another command" }
      }));
      const workID = String(created.body.work.id);
      const updated = await authed.patch(work(workID), {
        audit: audit("work-update-1", "supervisor"),
        expected_revision: created.body.work.revision,
        goal: "Ship and verify Work API",
        title: "Verified Work API"
      });
      const enqueued = await authed.post(`${work(workID)}/actions/enqueue`, {
        audit: audit("work-enqueue-1", "supervisor"), expected_revision: updated.body.work.revision
      });
      const cancelled = await authed.post(`${work(workID)}/actions/cancel`, {
        audit: audit("work-cancel-1", "supervisor"), expected_revision: enqueued.body.work.revision
      });
  
      expect(created.status).toBe(201);
      expect(created.body.work.acceptance).toMatchObject({ version: 1 });
      expect(created.body).toMatchObject({
        mutation: { applied: true, audit_event_id: "work-create-1" },
        work: {
          goal: "Ship Work API",
          provenance: { origin: { completeness: "complete", correlation_id: "correlation:work-create-1" } },
          status: "triage",
          title: "Work API"
        }
      });
      expect(created.body.mutation).not.toHaveProperty("shadow");
      expect(rowCount(db, "issues")).toBe(1);
      expect(updated).toMatchObject({ status: 200, body: { work: { goal: "Ship and verify Work API", title: "Verified Work API" } } });
      expect(enqueued).toMatchObject({ status: 200, body: { work: { status: "todo" } } });
      expect(cancelled).toMatchObject({ status: 200, body: { work: { status: "cancelled" } } });
      expect(JSON.parse(db.sqlite.query<{ payload: string }, []>(
        "select payload from issue_events where type='issue.created' order by id asc limit 1"
      ).get()?.payload || "{}")).toMatchObject({
        actor: { id: "actor-work-create-1", kind: "user" },
        event_id: "work-create-1",
        gate: { authority: "deterministic_policy", decision: "allow", policy_ref: "xuanwu-work-http-authenticated-write-v1" },
        operation: "create",
        outcome: "applied"
      });
      expect(adapterAudits(db).map((item) => [item.operation, item.outcome])).toEqual([
        ["update", "applied"],
        ["enqueue", "applied"],
        ["cancel", "applied"]
      ]);
      expect(rowCount(db, "works")).toBe(0);
    });
  
  test("derives a Work title from the goal when the title is omitted", async () => {
      const { authed } = await workApi();
  
      expect(await authed.post("/api/works", {
        audit: audit("work-create-without-title", "user"),
        goal: "Investigate the failing form",
        project_id: "demo",
        status: "triage",
        type: "engineering_task"
      })).toMatchObject({ status: 201, body: { work: { goal: "Investigate the failing form", title: "Investigate the failing form" } } });
    });
  
  test("updates Issue dependencies through the same audited Work authority with replay and explicit clear", async () => {
      const { db, api } = await workApi();
      const upstream = createIssue(db, { project_id: "demo", status: "triage", title: "Upstream" });
      const downstream = createIssue(db, { project_id: "demo", status: "triage", title: "Downstream" });
      const workID = issueIDToWorkID(downstream.id);
      const before = (await api.get(work(workID))).body.work;
      const payload = { audit: audit("work-dependencies-set", "user"), depends_on_issue_ids: [upstream.id], expected_revision: before.revision };
  
      const updated = await api.patch(work(workID), payload);
      expect(updated.status).toBe(200);
      expect((await api.patch(work(workID), payload)).status).toBe(200);
      expect((await api.patch(work(workID), {
        audit: audit("work-dependencies-clear", "user"), depends_on_issue_ids: [], expected_revision: updated.body.work.revision
      })).status).toBe(200);
      expect(db.sqlite.query("select dependency_issue_ids_json from issues where id=?").get(downstream.id))
        .toEqual({ dependency_issue_ids_json: "[]" });
      expect(db.sqlite.query("select count(*) as count from work_relations where kind='depends_on' and source_work_id=?").get(workID))
        .toEqual({ count: 0 });
      expect(adapterAudits(db).map((item) => item.event_id)).toEqual(["work-dependencies-set", "work-dependencies-clear"]);
    });
}
