import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { createIssue } from "../db/repositories/issueCreate.ts";
import { insertWorkRecord, insertWorkRelationRecord } from "../db/repositories/workLedger.ts";
import { createPiAction } from "../db/repositories/pi/actions.ts";
import type { DependencyRelation } from "../domain/work/contracts.ts";
import { getIssueAsWork, issueIDToWorkID } from "../domain/work/issueAdapter.ts";
import { createDefaultRouter, createRequestHandler } from "./server.ts";

const BASE_URL = "http://127.0.0.1:3008";
const AUTH_TOKEN = "work-api-test-token";
const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) {
    const path = tempRoots.pop();
    if (path) await rm(path, { force: true, recursive: true });
  }
});

describe("Work HTTP API", () => {
  test("lists, filters, sorts and pages Issue-authoritative Work with detail relations", async () => {
    const db = await openFixtureDatabase();
    try {
      insertProject(db, "demo");
      const alpha = createIssue(db, {
        description: "Alpha goal",
        project_id: "demo",
        status: "triage",
        title: "Alpha"
      });
      createIssue(db, { description: "Charlie goal", project_id: "demo", status: "triage", title: "Charlie" });
      createIssue(db, { description: "Bravo goal", project_id: "demo", status: "todo", title: "Bravo" });
      createPiAction(db, {
        action_type: "issue.comment",
        id: "action-alpha",
        issue_id: alpha.id,
        project_id: "demo",
        status: "executing"
      });
      const router = createDefaultRouter({ database: db });

      const list = await router.handle(new Request(
        `${BASE_URL}/api/works?project_id=demo&status=triage&type=engineering_task&sort=title&order=asc&page=2&page_size=1`
      ));
      const listBody = await body(list);
      const searched = await router.handle(new Request(`${BASE_URL}/api/works?project_id=demo&q=alpha`));
      const searchedBody = await body(searched);
      const detail = await router.handle(new Request(
        `${BASE_URL}/api/works/${encodeURIComponent(issueIDToWorkID(alpha.id))}`
      ));
      const detailBody = await body(detail);
      const relations = await router.handle(new Request(
        `${BASE_URL}/api/work-relations?project_id=demo&kind=execution&page=1&page_size=10`
      ));
      const relationBody = await body(relations);

      expect(list.status).toBe(200);
      expect(listBody).toMatchObject({
        compatibility: { read_authority: "issues", target_shadow: "disabled" },
        items: [{ title: "Charlie", type: "engineering_task" }],
        page: 2,
        page_size: 1,
        total: 2,
        total_pages: 2
      });
      expect(searched.status).toBe(200);
      expect(searchedBody).toMatchObject({ items: [{ title: "Alpha" }], total: 1 });
      expect(detail.status).toBe(200);
      expect(detailBody).toMatchObject({
        relations: {
          items: [{ kind: "execution", lifecycle: "active", work_id: issueIDToWorkID(alpha.id) }],
          total: 1
        },
        work: { goal: "Alpha goal", id: issueIDToWorkID(alpha.id), title: "Alpha" }
      });
      expect(relations.status).toBe(200);
      expect(relationBody).toMatchObject({
        items: [{ kind: "execution", source_ref: { external_id: "action-alpha" } }],
        total: 1,
        unmapped: []
      });
      expect(rowCount(db, "works")).toBe(0);
      expect(rowCount(db, "work_relations")).toBe(0);
    } finally {
      db.close();
    }
  });

  test("creates, updates, enqueues and cancels through the Issue adapter with idempotent audit", async () => {
    const db = await openFixtureDatabase();
    try {
      insertProject(db, "demo");
      const router = createDefaultRouter({ database: db });
      const handle = createRequestHandler(router, AUTH_TOKEN);
      const createPayload = {
        audit: audit("work-create-1", "user"),
        goal: "Ship Work API",
        project_id: "demo",
        status: "triage",
        title: "Work API",
        type: "engineering_task"
      };

      const unauthorized = await handle(jsonRequest("/api/works", "POST", createPayload));
      const created = await handle(authenticatedJsonRequest("/api/works", "POST", createPayload));
      const replay = await handle(authenticatedJsonRequest("/api/works", "POST", createPayload));
      const conflictingReplay = await handle(authenticatedJsonRequest("/api/works", "POST", {
        ...createPayload,
        title: "Conflicting replay"
      }));
      const createdBody = await body(created);
      const work = createdBody.work as Record<string, unknown>;
      const workID = String(work.id);

      const updated = await handle(authenticatedJsonRequest(`/api/works/${encodeURIComponent(workID)}`, "PATCH", {
        audit: audit("work-update-1", "supervisor"),
        expected_revision: work.revision,
        goal: "Ship and verify Work API",
        title: "Verified Work API"
      }));
      const updatedWork = (await body(updated)).work as Record<string, unknown>;
      const enqueued = await handle(authenticatedJsonRequest(
        `/api/works/${encodeURIComponent(workID)}/actions/enqueue`,
        "POST",
        { audit: audit("work-enqueue-1", "supervisor"), expected_revision: updatedWork.revision }
      ));
      const enqueuedWork = (await body(enqueued)).work as Record<string, unknown>;
      const cancelled = await handle(authenticatedJsonRequest(
        `/api/works/${encodeURIComponent(workID)}/actions/cancel`,
        "POST",
        { audit: audit("work-cancel-1", "supervisor"), expected_revision: enqueuedWork.revision }
      ));
      const cancelledBody = await body(cancelled);

      expect(unauthorized.status).toBe(401);
      expect(await unauthorized.json()).toEqual({ message: "unauthorized" });
      expect(created.status).toBe(201);
      expect(replay.status).toBe(201);
      expect(conflictingReplay.status).toBe(409);
      expect(await body(conflictingReplay)).toEqual({
        code: "work_event_conflict",
        message: "Work audit event conflicts with another command"
      });
      expect(createdBody).toMatchObject({
        mutation: { applied: true, audit_event_id: "work-create-1", shadow: { mode: "disabled" } },
        work: {
          goal: "Ship Work API",
          provenance: { origin: { completeness: "complete", correlation_id: "correlation:work-create-1" } },
          status: "triage",
          title: "Work API"
        }
      });
      expect(rowCount(db, "issues")).toBe(1);
      expect(updated.status).toBe(200);
      expect(updatedWork).toMatchObject({ goal: "Ship and verify Work API", title: "Verified Work API" });
      expect(enqueued.status).toBe(200);
      expect(enqueuedWork.status).toBe("todo");
      expect(cancelled.status).toBe(200);
      expect(cancelledBody.work).toMatchObject({ status: "cancelled" });
      expect(createdAudit(db)).toMatchObject({
        actor: { id: "actor-work-create-1", kind: "user" },
        event_id: "work-create-1",
        gate: {
          authority: "deterministic_policy",
          decision: "allow",
          policy_ref: "xuanwu-work-http-authenticated-write-v1"
        },
        operation: "create",
        outcome: "applied"
      });
      expect(adapterAudits(db).map((item) => [item.operation, item.outcome])).toEqual([
        ["update", "applied"],
        ["enqueue", "applied"],
        ["cancel", "applied"]
      ]);
      expect(rowCount(db, "works")).toBe(0);
    } finally {
      db.close();
    }
  });

  test("returns stable errors for illegal state, missing Work and untrusted request gate input", async () => {
    const db = await openFixtureDatabase();
    try {
      insertProject(db, "demo");
      const done = createIssue(db, { project_id: "demo", status: "done", title: "Already done" });
      const workID = issueIDToWorkID(done.id);
      const router = createDefaultRouter({ database: db });
      const doneDetail = await router.handle(new Request(`${BASE_URL}/api/works/${encodeURIComponent(workID)}`));
      const revision = ((await body(doneDetail)).work as Record<string, unknown>).revision;

      const illegal = await router.handle(jsonRequest(
        `/api/works/${encodeURIComponent(workID)}/actions/cancel`,
        "POST",
        { audit: audit("illegal-cancel", "supervisor"), expected_revision: revision }
      ));
      const missing = await router.handle(new Request(
        `${BASE_URL}/api/works/${encodeURIComponent("xw:work:issues:999999")}`
      ));
      const invalidPage = await router.handle(new Request(`${BASE_URL}/api/works?page_size=101`));
      const untrustedGate = await router.handle(jsonRequest("/api/works", "POST", {
        audit: { ...audit("request-gate", "supervisor"), gate: { decision: "allow" } },
        goal: "Must not create",
        project_id: "demo",
        title: "Must not create"
      }));
      const objective = await router.handle(jsonRequest("/api/works", "POST", {
        audit: audit("objective-create", "supervisor"),
        goal: "Objective goal",
        project_id: "demo",
        title: "Objective",
        type: "objective"
      }));

      expect(illegal.status).toBe(409);
      expect(await body(illegal)).toMatchObject({
        code: "work_mutation_rejected",
        message: "Work mutation rejected",
        violations: ["illegal Work transition done -> cancelled"],
        work: { status: "done" }
      });
      expect(missing.status).toBe(404);
      expect(await body(missing)).toEqual({ code: "work_not_found", message: "Work not found" });
      expect(invalidPage.status).toBe(400);
      expect(await body(invalidPage)).toEqual({ code: "invalid_request", message: "page_size must not exceed 100" });
      expect(untrustedGate.status).toBe(400);
      expect(await body(untrustedGate)).toEqual({ code: "invalid_request", message: "Unsupported fields: gate" });
      expect(objective.status).toBe(409);
      expect(await body(objective)).toEqual({
        code: "work_authority_restriction",
        message: "objective Work creation is unavailable while Issues remain the write authority"
      });
      expect(adapterAudits(db)).toContainEqual(expect.objectContaining({
        event_id: "illegal-cancel",
        operation: "cancel",
        outcome: "rejected"
      }));
      expect(rowCount(db, "issues")).toBe(1);
    } finally {
      db.close();
    }
  });

  test("declares audited readiness requirements and exposes the live Evidence gap on Work Detail", async () => {
    const db = await openFixtureDatabase();
    try {
      insertProject(db, "demo");
      const source = createIssue(db, { project_id: "demo", status: "done", title: "Source release" });
      const downstream = createIssue(db, { project_id: "demo", status: "todo", title: "Live cleanup" });
      addDependency(db, downstream.id, source.id);
      const router = createDefaultRouter({ database: db });
      const workID = issueIDToWorkID(downstream.id);
      const payload = {
        audit: audit("readiness-v1", "supervisor"),
        requirements: [{
          environment: "production",
          migration_gate: "G4",
          release_window: "W2",
          required_stage: "gate_passed",
          runtime_revision: "v0.1.0-760-g9f1e2d3",
          source_revision: "9f1e2d3",
          source_work_id: issueIDToWorkID(source.id)
        }],
        schema_version: 1,
        work_id: workID
      };

      const declared = await router.handle(jsonRequest(
        `/api/works/${encodeURIComponent(workID)}/readiness-requirements`, "PUT", payload
      ));
      const replay = await router.handle(jsonRequest(
        `/api/works/${encodeURIComponent(workID)}/readiness-requirements`, "PUT", payload
      ));
      const detail = await router.handle(new Request(`${BASE_URL}/api/works/${encodeURIComponent(workID)}`));

      expect(declared.status).toBe(200);
      expect(await body(declared)).toMatchObject({
        mutation: { replayed: false },
        readiness: {
          current_stage: "source_ready",
          missing_evidence: [
            "deployed:production:v0.1.0-760-g9f1e2d3",
            "observed:production:W2",
            "gate_passed:G4"
          ],
          ready: false,
          status: "waiting"
        }
      });
      expect(replay.status).toBe(200);
      expect(await body(replay)).toMatchObject({ mutation: { replayed: true } });
      expect(await body(detail)).toMatchObject({ readiness: { contract: "xw.delivery-readiness.projection.v1" } });
    } finally {
      db.close();
    }
  });
});

async function openFixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-work-api-"));
  tempRoots.push(root);
  return openDatabase({ stateDir: join(root, "state") });
}

function insertProject(db: RunnerDatabase, id: string): void {
  const timestamp = "2026-07-16T00:00:00Z";
  db.sqlite.run(`insert into projects
    (id, name, cwd, provider, auto_run, created_at, updated_at)
    values (?, ?, ?, 'codex', 0, ?, ?)`, [id, id, `/tmp/${id}`, timestamp, timestamp]);
}

function audit(eventID: string, kind: "supervisor" | "user") {
  return {
    actor: { id: `actor-${eventID}`, kind },
    correlation_id: `correlation:${eventID}`,
    event_id: eventID,
    occurred_at: "2026-07-16T01:00:00Z",
    reason: `apply ${eventID}`
  };
}

function jsonRequest(path: string, method: string, value: unknown): Request {
  return new Request(`${BASE_URL}${path}`, {
    body: JSON.stringify(value),
    headers: { "content-type": "application/json" },
    method
  });
}

function authenticatedJsonRequest(path: string, method: string, value: unknown): Request {
  const request = jsonRequest(path, method, value);
  request.headers.set("authorization", `Bearer ${AUTH_TOKEN}`);
  return request;
}

async function body(response: Response): Promise<Record<string, any>> {
  return await response.json() as Record<string, any>;
}

function rowCount(db: RunnerDatabase, table: string): number {
  return db.sqlite.query<{ count: number }, []>(`select count(*) as count from ${table}`).get()?.count ?? 0;
}

function createdAudit(db: RunnerDatabase): Record<string, unknown> {
  const row = db.sqlite.query<{ payload: string }, []>(`
    select payload from issue_events where type='issue.created' order by id asc limit 1
  `).get();
  return JSON.parse(row?.payload || "{}") as Record<string, unknown>;
}

function adapterAudits(db: RunnerDatabase): Array<Record<string, unknown>> {
  return db.sqlite.query<{ payload: string }, []>(`
    select payload from issue_events where type='issue.work_adapter_write' order by id asc
  `).all().map((row) => JSON.parse(row.payload) as Record<string, unknown>);
}

function addDependency(db: RunnerDatabase, issueID: number, dependencyID: number): void {
  const source = getIssueAsWork(db, issueID);
  const target = getIssueAsWork(db, dependencyID);
  if (!source || !target) throw new Error("missing Work fixture");
  insertWorkRecord(db, source);
  insertWorkRecord(db, target);
  const relation: DependencyRelation = {
    actor: { id: "work-api-test", kind: "runner" },
    audit_event_ref: `work-api:${issueID}:${dependencyID}`,
    correlation_id: `work-api:${issueID}:${dependencyID}`,
    depends_on_work_id: target.id,
    kind: "depends_on",
    occurred_at: "2026-07-16T01:00:00.000Z",
    reason: "readiness API dependency",
    relation_id: `depends-on:${issueID}:${dependencyID}`,
    work_id: source.id
  };
  insertWorkRelationRecord(db, "demo", relation);
}
