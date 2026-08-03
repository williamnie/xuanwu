import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { createIssue } from "../db/repositories/issueCreate.ts";
import { createAgentProfile } from "../db/repositories/agentProfiles.ts";
import { getIssue } from "../db/repositories/issues.ts";
import { insertWorkRecord, insertWorkRelationRecord } from "../db/repositories/workLedger.ts";
import type { DependencyRelation } from "../domain/work/contracts.ts";
import { readIssueDependency } from "../domain/work/issueDependency.ts";
import { getIssueAsWork, issueIDToWorkID, workIDToIssueID } from "../domain/work/issueAdapter.ts";
import { createDefaultRouter, createRequestHandler } from "./server.ts";
import type { ExecutorProvider, ExecutorProviderId, ProviderRunInput } from "../providers/types.ts";

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
  test("atomically materializes structured dependencies before a todo Work can be scheduled", async () => {
    const db = await openFixtureDatabase();
    try {
      insertProject(db, "demo");
      const upstream = createIssue(db, {
        project_id: "demo",
        status: "todo",
        title: "Upstream"
      });
      const router = createDefaultRouter({ database: db });
      const handle = createRequestHandler(router, AUTH_TOKEN);

      const created = await handle(authenticatedJsonRequest("/api/works", "POST", {
        audit: audit("dependent-work-create", "supervisor"),
        depends_on_issue_ids: [upstream.id],
        goal: "Wait for upstream delivery",
        project_id: "demo",
        status: "todo",
        title: "Dependent Work",
        type: "engineering_task"
      }));
      const workID = String(((await body(created)).work as Record<string, unknown>).id);
      const issueID = workIDToIssueID(workID);

      expect(created.status).toBe(201);
      expect(readIssueDependency(db, issueID)).toMatchObject({
        direct_dependencies: [{ issue_id: upstream.id }],
        ready: false,
        reason: "waiting_dependency"
      });
      expect(rowCount(db, "work_relations")).toBe(1);
    } finally {
      db.close();
    }
  });

  test("lists, filters, sorts and pages Issue-authoritative Work without relation projections", async () => {
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
      const router = createDefaultRouter({ database: db });

      const list = await router.handle(new Request(
        `${BASE_URL}/api/works?project_id=demo&status=triage&type=engineering_task&sort=title&order=asc&page=2&page_size=1`
      ));
      const listBody = await body(list);
      const searched = await router.handle(new Request(`${BASE_URL}/api/works?project_id=demo&q=alpha`));
      const searchedBody = await body(searched);
      const board = await router.handle(new Request(
        `${BASE_URL}/api/works/board?project_id=demo&page_size=1&sort=title&order=asc`
      ));
      const boardBody = await body(board);
      const detail = await router.handle(new Request(
        `${BASE_URL}/api/works/${encodeURIComponent(issueIDToWorkID(alpha.id))}`
      ));
      const detailBody = await body(detail);
      const removedRelations = await router.handle(new Request(`${BASE_URL}/api/work-relations`));

      expect(list.status).toBe(200);
      expect(listBody).toMatchObject({
        items: [{ title: "Charlie", type: "engineering_task" }],
        page: 2,
        page_size: 1,
        total: 2,
        total_pages: 2
      });
      expect(searched.status).toBe(200);
      expect(searchedBody).toMatchObject({ items: [{ title: "Alpha" }], total: 1 });
      expect(board.status).toBe(200);
      expect(boardBody).toMatchObject({
        lanes: {
          todo: { items: [{ title: "Bravo" }], page: 1, page_size: 1, total: 1, total_pages: 1 },
          triage: { items: [{ title: "Alpha" }], page: 1, page_size: 1, total: 2, total_pages: 2 }
        },
        page_size: 1,
        project_id: "demo",
        sort: { field: "title", order: "asc" }
      });
      expect(detail.status).toBe(200);
      expect(detailBody).toMatchObject({
        decision: { owner: "pi", request: null },
        work: { goal: "Alpha goal", id: issueIDToWorkID(alpha.id), title: "Alpha" }
      });
      expect(removedRelations.status).toBe(404);
      expect(listBody).not.toHaveProperty("compatibility");
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
      expect(work.acceptance).toMatchObject({ version: 1 });
      expect(replay.status).toBe(201);
      expect(conflictingReplay.status).toBe(409);
      expect(await body(conflictingReplay)).toEqual({
        code: "work_event_conflict",
        message: "Work audit event conflicts with another command"
      });
      expect(createdBody).toMatchObject({
        mutation: { applied: true, audit_event_id: "work-create-1" },
        work: {
          goal: "Ship Work API",
          provenance: { origin: { completeness: "complete", correlation_id: "correlation:work-create-1" } },
          status: "triage",
          title: "Work API"
        }
      });
      expect(createdBody.mutation).not.toHaveProperty("shadow");
      expect(rowCount(db, "issues")).toBe(1);
      expect(updated.status).toBe(200);
      expect(updatedWork).toMatchObject({
        goal: "Ship and verify Work API",
        title: "Verified Work API"
      });
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

  test("declares audited readiness requirements without expanding Work Detail", async () => {
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
      expect(await body(detail)).toMatchObject({
        decision: { owner: "pi" },
        work: { id: workID }
      });
    } finally {
      db.close();
    }
  });

  test("creates and patches per-Work Agent Profiles with effective provider and running lock", async () => {
    const db = await openFixtureDatabase();
    try {
      insertProject(db, "demo");
      createAgentProfile(db, { id: "codex-work", name: "Codex Work", provider: "codex", model: "gpt-5.6" });
      createAgentProfile(db, { id: "claude-work", name: "Claude Work", provider: "claude", model: "claude-sonnet" });
      db.sqlite.run("update projects set default_agent_profile_id='codex-work' where id='demo'");
      const router = createDefaultRouter({
        database: db,
        providers: { codex: readyProvider("codex"), claude: readyProvider("claude") }
      });

      const inherited = await router.handle(jsonRequest("/api/works", "POST", {
        audit: audit("work-inherited", "user"),
        agent_profile_id: "",
        goal: "inherit default",
        project_id: "demo",
        status: "triage",
        title: "Inherited",
        type: "engineering_task"
      }));
      const claudeCreated = await router.handle(jsonRequest("/api/works", "POST", {
        audit: audit("work-claude", "user"),
        agent_profile_id: "claude-work",
        goal: "use Claude",
        project_id: "demo",
        status: "triage",
        title: "Claude Work",
        type: "engineering_task"
      }));
      const inheritedWork = (await body(inherited)).work as Record<string, any>;
      const claudeWork = (await body(claudeCreated)).work as Record<string, any>;

      expect(inheritedWork).toMatchObject({
        agent_profile_id: "",
        effective_provider: "codex",
        effective_agent_profile: { id: "codex-work", provider: "codex", source: "project_default" }
      });
      expect(claudeWork).toMatchObject({
        agent_profile_id: "claude-work",
        effective_provider: "claude",
        effective_agent_profile: { id: "claude-work", model: "claude-sonnet", source: "work" }
      });

      const patched = await router.handle(jsonRequest(
        `/api/works/${encodeURIComponent(claudeWork.id)}`,
        "PATCH",
        { audit: audit("work-switch", "user"), expected_revision: claudeWork.revision, agent_profile_id: "codex-work" }
      ));
      expect(await body(patched)).toMatchObject({
        work: { agent_profile_id: "codex-work", effective_provider: "codex", effective_agent_profile: { source: "work" } }
      });

      const invalid = await router.handle(jsonRequest("/api/works", "POST", {
        audit: audit("work-invalid-profile", "user"),
        agent_profile_id: "missing-profile",
        goal: "must fail",
        project_id: "demo",
        title: "Invalid profile"
      }));
      expect(invalid.status).toBe(400);
      expect(await body(invalid)).toMatchObject({ code: "invalid_agent_profile" });

      const issueID = workIDToIssueID(String(claudeWork.id));
      db.sqlite.run("update issues set status='in_progress' where id=?", [issueID]);
      const runningWork = getIssueAsWork(db, issueID)!;
      const sameProfile = await router.handle(jsonRequest(
        `/api/works/${encodeURIComponent(claudeWork.id)}`,
        "PATCH",
        {
          audit: audit("work-running-same-profile", "user"),
          expected_revision: runningWork.revision,
          agent_profile_id: "codex-work",
          title: "Claude Work while running"
        }
      ));
      expect(sameProfile.status).toBe(200);
      expect(await body(sameProfile)).toMatchObject({
        work: { agent_profile_id: "codex-work", status: "in_progress", title: "Claude Work while running" }
      });
      const revisedRunningWork = getIssueAsWork(db, issueID)!;
      const locked = await router.handle(jsonRequest(
        `/api/works/${encodeURIComponent(claudeWork.id)}`,
        "PATCH",
        { audit: audit("work-running-lock", "user"), expected_revision: revisedRunningWork.revision, agent_profile_id: "" }
      ));
      expect(locked.status).toBe(409);
      expect(await body(locked)).toEqual({
        code: "running_work_profile_locked",
        message: "running Work agent_profile_id cannot be changed"
      });
      expect(getIssue(db, issueID)?.agent_profile_id).toBe("codex-work");
    } finally {
      db.close();
    }
  });
});

function readyProvider(id: "codex" | "claude"): ExecutorProvider {
  return {
    id: id as ExecutorProviderId,
    capabilities: ["issue_execution"],
    async run(_input: ProviderRunInput) { return { runId: `${id}-unused` }; },
    runtimeStatus: () => ({
      active_sessions: 0,
      api_key_configured: id === "claude",
      mode: id === "claude" ? "sdk" : "app-server",
      ready: true,
      version: "fixture"
    })
  };
}

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
