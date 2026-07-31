import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { EVIDENCE_RECORDED_EVENT_TYPE, listStoredEvidence, recordEvidenceRecords } from "../db/repositories/evidence.ts";
import { getIssue } from "../db/repositories/issues.ts";
import { insertWorkRecord, insertWorkRelationRecord } from "../db/repositories/workLedger.ts";
import type { EvidenceRecord } from "../domain/evidence/contracts.ts";
import { declareIssueReadinessRequirements } from "../domain/readiness/contracts.ts";
import type { DependencyRelation } from "../domain/work/contracts.ts";
import { getIssueAsWork, issueIDToWorkID } from "../domain/work/issueAdapter.ts";
import type { ExecutorProvider, ProviderRunInput, ProviderRunResult } from "../providers/types.ts";
import { isProjectLoopActive } from "../runner/projectLoopManager.ts";
import { createDefaultRouter, createRequestHandler } from "./server.ts";

const BASE_URL = "http://127.0.0.1:3008";
const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) {
    const path = tempRoots.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

describe("Evidence HTTP API", () => {
  test("paginates bounded summaries and provides full detail plus authenticated artifact bytes", async () => {
    const db = await fixture();
    try {
      const issueID = insertIssue(db, "Evidence list", "done");
      const runID = insertRun(db, issueID, "done", "session-list");
      const artifactContent = "decisive output kept out of list payload\n";
      const artifactSha = createHash("sha256").update(artifactContent).digest("hex");
      const artifactRef = `artifacts/evidence-command-output/${artifactSha.slice(0, 2)}/${artifactSha}.log`;
      const artifactPath = join(dirname(db.path), artifactRef);
      mkdirSync(dirname(artifactPath), { recursive: true });
      writeFileSync(artifactPath, artifactContent);
      const records = [
        evidence(issueID, runID, 1, "passed"),
        evidence(issueID, runID, 2, "failed", {
          artifact_refs: [{ kind: "log", ref: artifactRef, media_type: "text/plain; charset=utf-8", sha256: artifactSha }],
          excerpt: "x".repeat(8_000),
          summary: `failure reason ${"y".repeat(500)}`
        }),
        evidence(issueID, runID, 3, "blocked")
      ];
      recordEvidenceRecords(db, issueID, records, { recorded_at: timestamp(10), source: "evidence-api-test" });
      const router = createDefaultRouter({ database: db });

      const first = await router.handle(new Request(
        `${BASE_URL}/api/evidence?work_id=${encodeURIComponent(`xw:work:issues:${issueID}`)}&limit=2`
      ));
      const firstBody = await first.json() as Record<string, any>;
      const second = await router.handle(new Request(`${BASE_URL}/api/evidence?cursor=${firstBody.next_cursor}&limit=2`));
      const detailID = records[1]!.id;
      const detail = await router.handle(new Request(`${BASE_URL}/api/evidence/${encodeURIComponent(detailID)}`));
      const downloadPath = `${BASE_URL}/api/evidence/${encodeURIComponent(detailID)}/artifacts/0`;
      const authenticated = createRequestHandler(router, "evidence-download-token");
      const unauthorizedDownload = await authenticated(new Request(downloadPath));
      const download = await authenticated(new Request(downloadPath, {
        headers: { authorization: "Bearer evidence-download-token" }
      }));

      expect(first.status).toBe(200);
      expect(firstBody).toMatchObject({
        compatibility: { fallback_applied: false, read_authority: "issue_events:evidence.recorded.v1" },
        has_more: true,
        limit: 2
      });
      expect(firstBody.items).toHaveLength(2);
      expect(firstBody.items[1]).toMatchObject({
        artifact_count: 1,
        decisive_summary: expect.stringMatching(/^failure reason .+…$/),
        status: "failed",
        storage_source: "structured"
      });
      expect(String(firstBody.items[1].decisive_summary).length).toBeLessThanOrEqual(320);
      expect(JSON.stringify(firstBody)).not.toContain("x".repeat(100));
      expect(second.status).toBe(200);
      expect((await second.json() as Record<string, any>).items).toHaveLength(1);
      expect(detail.status).toBe(200);
      expect(await detail.json()).toMatchObject({
        artifacts: [{ downloadable: true, download_url: expect.stringContaining("/artifacts/0") }],
        evidence: { decisive_output: { excerpt: "x".repeat(8_000) }, id: detailID }
      });
      expect(unauthorizedDownload.status).toBe(401);
      expect(download.status).toBe(200);
      expect(download.headers.get("content-disposition")).toContain("attachment");
      expect(await download.text()).toBe(artifactContent);
    } finally {
      db.close();
    }
  });

  test("persists and exposes decisive passed and failed Work completion evidence", async () => {
    const db = await fixture();
    try {
      const passedIssueID = insertIssue(db, "Passing Work", "in_progress");
      const failedIssueID = insertIssue(db, "Failing Work", "in_progress");
      const passedRunID = insertRun(db, passedIssueID, "in_progress", "session-pass");
      const failedRunID = insertRun(db, failedIssueID, "in_progress", "session-fail");
      insertCommandEvent(db, passedIssueID, "bun test src/http/evidenceApi.test.ts", 0);
      insertCommandEvent(db, failedIssueID, "bun test src/http/evidenceApi.test.ts", 1);
      const router = createDefaultRouter({ database: db });

      const passed = await patchDone(router, passedIssueID);
      const failed = await patchDone(router, failedIssueID);
      const passedEvidence = await router.handle(new Request(
        `${BASE_URL}/api/evidence?run_id=${encodeURIComponent(passedRunID)}`
      ));
      const failedEvidence = await router.handle(new Request(
        `${BASE_URL}/api/evidence?session_ref=${encodeURIComponent("codex:session-fail")}`
      ));
      const passedBody = await passedEvidence.json() as Record<string, any>;
      const failedBody = await failedEvidence.json() as Record<string, any>;
      const passedDetail = await router.handle(new Request(
        `${BASE_URL}/api/evidence/${encodeURIComponent(passedBody.items[0].id)}`
      ));

      expect(passed).toMatchObject({
        status: "done",
        error: ""
      });
      expect(failed).toMatchObject({ status: "failed", error: expect.stringContaining("Verification failed") });
      expect(passedBody.items).toEqual([
        expect.objectContaining({ kind: "test", run_id: passedRunID, status: "passed" })
      ]);
      expect(passedBody.verification_gap).toMatchObject({ reason: "none" });
      expect(failedBody.items).toEqual([
        expect.objectContaining({
          decisive_summary: expect.stringContaining("failed with exit 1"),
          kind: "test",
          run_id: failedRunID,
          status: "failed"
        })
      ]);
      expect(failedBody.verification_gap).toMatchObject({ reason: "failed" });
      expect(await passedDetail.json()).toMatchObject({
        verifier_review_refs: [{
          finding_ids: expect.arrayContaining(["requirement:current-run-check"]),
          policy_ref: "verification-policy:agent-execution-contract@1",
          recommended_next_action: { action: "complete_via_gate" },
          verdict: "pass"
        }]
      });
      expect(db.sqlite.query<{ count: number }, [string]>(
        "select count(*) as count from issue_events where type=?"
      ).get(EVIDENCE_RECORDED_EVENT_TYPE)?.count).toBe(2);
    } finally {
      db.close();
    }
  });

  test("returns explicit empty and invalid-request states without projecting unrelated Issues", async () => {
    const db = await fixture();
    try {
      const issueID = insertIssue(db, "No Evidence", "todo");
      const router = createDefaultRouter({ database: db });
      const empty = await router.handle(new Request(`${BASE_URL}/api/evidence?issue_id=${issueID}`));
      const badCursor = await router.handle(new Request(`${BASE_URL}/api/evidence?cursor=not-a-cursor`));
      const missing = await router.handle(new Request(
        `${BASE_URL}/api/evidence/${encodeURIComponent("xw:evidence:issue_events:999999")}`
      ));

      expect(empty.status).toBe(200);
      expect(await empty.json()).toMatchObject({
        has_more: false,
        items: [],
        projection_errors: [],
        verification_gap: { reason: "not_executed" }
      });
      expect(badCursor.status).toBe(400);
      expect(await badCursor.json()).toEqual({ code: "invalid_cursor", message: "Evidence cursor is invalid" });
      expect(missing.status).toBe(404);
      expect(await missing.json()).toEqual({ code: "evidence_not_found", message: "Evidence not found" });
    } finally {
      db.close();
    }
  });

  test("keeps targeted W1 command projection as a read-only compatibility fallback", async () => {
    const db = await fixture();
    try {
      const issueID = insertIssue(db, "Legacy projected Evidence", "in_progress");
      insertRun(db, issueID, "in_progress", "session-legacy");
      insertCommandEvent(db, issueID, "bun test src/http/evidenceApi.test.ts", 0);
      const router = createDefaultRouter({ database: db });

      const response = await router.handle(new Request(`${BASE_URL}/api/evidence?issue_id=${issueID}`));
      const body = await response.json() as Record<string, any>;
      const detail = await router.handle(new Request(
        `${BASE_URL}/api/evidence/${encodeURIComponent(body.items[0].id)}`
      ));

      expect(response.status).toBe(200);
      expect(body).toMatchObject({
        compatibility: { fallback_applied: true, fallback_sources: ["compatibility_projection"] },
        items: [{ status: "passed", storage_source: "compatibility_projection" }]
      });
      expect(detail.status).toBe(200);
      expect(await detail.json()).toMatchObject({
        compatibility: { fallback_applied: true },
        storage_source: "compatibility_projection"
      });
      expect(db.sqlite.query<{ count: number }, [string]>(
        "select count(*) as count from issue_events where type=?"
      ).get(EVIDENCE_RECORDED_EVENT_TYPE)?.count).toBe(0);
    } finally {
      db.close();
    }
  });

  test("accepts delegated and post-deploy command results, replays idempotently, and closes late pending Evidence", async () => {
    const db = await fixture();
    try {
      const issueID = insertIssue(db, "Explicit verification", "in_progress");
      const runID = insertRun(db, issueID, "in_progress", "session-explicit");
      const router = createDefaultRouter({ database: db });
      const observed = Date.now();
      const failed = commandEvidenceBody(runID, "delegated_executor", "delegated-failed", 1, new Date(observed - 2_000).toISOString());
      const passed = commandEvidenceBody(runID, "post_deploy_verifier", "post-deploy-passed", 0, new Date(observed - 1_000).toISOString(), {
        command: "deploy --revision fixture; bun test smoke.test.ts"
      });

      const failedResponse = await postCommandEvidence(router, issueID, failed);
      const passedResponse = await postCommandEvidence(router, issueID, passed);
      const replay = await postCommandEvidence(router, issueID, passed);
      const conflict = await postCommandEvidence(router, issueID, { ...passed, observation: { ...passed.observation, exit_code: 1 } });
      const crossRun = await postCommandEvidence(router, issueID, { ...passed, correlation_id: "cross-run", run_id: "xw:run:issue_runs:issue-999-attempt-1" });
      const completed = await patchDone(router, issueID);
      const records = listStoredEvidence(db, { issue_ids: [issueID], limit: 10 }).items;

      expect(failedResponse.status).toBe(200);
      expect(await failedResponse.json()).toMatchObject({
        evidence: { decisive_output: { facts: { correlation_channel: "delegated_executor" } }, status: "failed" },
        replayed: false
      });
      expect(passedResponse.status).toBe(200);
      expect(await passedResponse.json()).toMatchObject({
        evidence: { decisive_output: { facts: { correlation_channel: "post_deploy_verifier" } }, status: "passed" }
      });
      expect(await replay.json()).toMatchObject({ replayed: true });
      expect(conflict.status).toBe(409);
      expect(crossRun.status).toBe(409);
      expect(completed).toMatchObject({
        status: "done",
        error: ""
      });
      expect(records.map((item) => item.evidence.status).sort()).toEqual(["failed", "passed"]);

      const lateIssueID = insertIssue(db, "Late verification", "pending_verification");
      const lateRunID = insertRun(db, lateIssueID, "done", "session-late");
      const late = await postCommandEvidence(
        router,
        lateIssueID,
        commandEvidenceBody(lateRunID, "delegated_executor", "late-after-disconnect", 0, new Date(observed).toISOString())
      );
      expect(await late.json()).toMatchObject({
        gate: { decision: "passed", issue_status: "done", target_status: "done" }
      });
      expect(getIssue(db, lateIssueID)?.status).toBe("done");
    } finally {
      db.close();
    }
  });

  test("records strict runtime readiness Evidence append-only and rejects missing rollback provenance", async () => {
    const db = await fixture();
    try {
      const issueID = insertIssue(db, "Runtime release", "done");
      const router = createDefaultRouter({ database: db });
      const record = readinessEvidence(issueID, "release-760");
      const posted = await postReadinessEvidence(router, issueID, record);
      const replay = await postReadinessEvidence(router, issueID, record);
      const invalid = readinessEvidence(issueID, "release-760-invalid");
      invalid.decisive_output.facts.rollback_ref = "";
      const rejected = await postReadinessEvidence(router, issueID, invalid);

      expect(posted.status).toBe(200);
      expect(await posted.json()).toMatchObject({ evidence: { id: record.id }, replayed: false });
      expect(replay.status).toBe(200);
      expect(await replay.json()).toMatchObject({ replayed: true });
      expect(rejected.status).toBe(400);
      expect(await rejected.json()).toMatchObject({
        code: "invalid_readiness_evidence",
        message: expect.stringContaining("rollback_ref")
      });
      expect(listStoredEvidence(db, { issue_ids: [issueID], limit: 10 }).items).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  test("wakes an auto-run project when new readiness Evidence makes a downstream Issue eligible", async () => {
    const db = await fixture();
    const provider = new ReadinessExecutionProvider();
    try {
      db.sqlite.run("update projects set auto_run=1 where id='demo'");
      const sourceID = insertIssue(db, "Runtime release", "done");
      const downstreamID = insertIssue(db, "Live-dependent cleanup", "todo");
      addReadinessDependency(db, downstreamID, sourceID);
      declareIssueReadinessRequirements(db, downstreamID, {
        audit: {
          actor: { id: "release-controller", kind: "system" },
          correlation_id: "release-760:wake",
          event_id: "release-760:wake:requirements",
          occurred_at: timestamp(10),
          reason: "Require the production runtime stamp before claim"
        },
        requirements: [{
          environment: "production",
          release_window: "W2",
          required_stage: "deployed",
          runtime_revision: "v0.1.0-760-g9f1e2d3",
          source_revision: "9f1e2d3",
          source_work_id: issueIDToWorkID(sourceID)
        }],
        schema_version: 1,
        work_id: issueIDToWorkID(downstreamID)
      });
      const router = createDefaultRouter({ database: db, providers: { codex: provider } });

      const response = await postReadinessEvidence(router, sourceID, readinessEvidence(sourceID, "release-760-wake"));
      await waitFor(() => provider.inputs.length === 1);

      expect(response.status).toBe(200);
      expect(provider.inputs[0]).toMatchObject({ issueId: downstreamID, projectId: "demo" });
      expect(getIssue(db, downstreamID)).toMatchObject({ attempt_count: 1, status: "in_progress" });
    } finally {
      await waitFor(() => !isProjectLoopActive("demo"));
      db.close();
    }
  });
});

async function fixture(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-evidence-api-"));
  tempRoots.push(root);
  const db = await openDatabase({ stateDir: join(root, "state") });
  const project = join(root, "project");
  mkdirSync(project, { recursive: true });
  db.sqlite.run(
    `insert into projects (id, name, cwd, provider, created_at, updated_at)
     values ('demo', 'demo', ?, 'codex', ?, ?)`,
    [project, timestamp(0), timestamp(0)]
  );
  return db;
}

function insertIssue(db: RunnerDatabase, title: string, status: string): number {
  db.sqlite.run(
    "insert into issues (project_id, title, status, created_at, updated_at) values ('demo', ?, ?, ?, ?)",
    [title, status, timestamp(0), timestamp(0)]
  );
  const id = db.sqlite.query<{ id: number }, []>("select last_insert_rowid() as id").get()?.id;
  if (!id) throw new Error("missing issue id");
  return id;
}

function insertRun(db: RunnerDatabase, issueID: number, status: string, sessionID: string): string {
  const id = `issue-${issueID}-attempt-1`;
  db.sqlite.run(
    `insert into issue_runs
      (id, issue_id, attempt, status, provider, provider_session_id, provider_turn_id, started_at, ended_at)
     values (?, ?, 1, ?, 'codex', ?, ?, ?, ?)`,
    [id, issueID, status, sessionID, `turn-${issueID}`, timestamp(1), status === "in_progress" ? "" : timestamp(2)]
  );
  return `xw:run:issue_runs:${id}`;
}

function evidence(
  issueID: number,
  runID: string,
  index: number,
  status: "blocked" | "failed" | "passed",
  overrides: { artifact_refs?: EvidenceRecord["artifact_refs"]; excerpt?: string; summary?: string } = {}
): EvidenceRecord {
  const at = timestamp(index + 2);
  return {
    schema_version: 1,
    id: `xw:evidence:issue_events:test-${issueID}-${index}` as EvidenceRecord["id"],
    work_id: `xw:work:issues:${issueID}` as EvidenceRecord["work_id"],
    run_id: runID as EvidenceRecord["run_id"],
    attempt_id: `${runID}~attempt:1` as EvidenceRecord["attempt_id"],
    revision: 0,
    kind: "test",
    status,
    created_at: at,
    observed_at: at,
    updated_at: at,
    completed_at: at,
    decisive_output: {
      summary: overrides.summary ?? `${status} focused test`,
      ...(overrides.excerpt ? { excerpt: overrides.excerpt } : {}),
      exit_code: status === "passed" ? 0 : 1,
      facts: { outcome: status === "passed" ? "passed" : status === "failed" ? "exit_nonzero" : "missing_exit" }
    },
    artifact_refs: overrides.artifact_refs ?? [],
    provenance: {
      assertion_origin: "tool_result",
      source_kind: "test_runner",
      source_ref: `fixture:test:${index}`,
      audit_event_ref: `fixture:audit:${index}`,
      producer: { id: "evidence-api-test", kind: "runner" }
    },
    redaction: { status: "not_required", policy_ref: "evidence-redaction:v1", redacted_paths: [] }
  };
}

function insertCommandEvent(db: RunnerDatabase, issueID: number, command: string, exitCode: number): void {
  const completedAtMs = Date.now();
  const rawPayload = JSON.stringify({
    item: {
      aggregatedOutput: exitCode === 0 ? "all tests passed" : "one test failed",
      command,
      commandActions: [{ type: "unknown", command }],
      completedAtMs,
      cwd: "/tmp/demo",
      durationMs: 10,
      exitCode,
      id: `command-${issueID}`,
      status: exitCode === 0 ? "completed" : "failed",
      type: "commandExecution"
    }
  });
  db.sqlite.run(
    "insert into issue_events (issue_id, type, payload, created_at) values (?, 'issue.log', ?, ?)",
    [issueID, JSON.stringify({ type: "tool", raw_method: "item/completed", raw_payload: rawPayload }), new Date(completedAtMs).toISOString()]
  );
}

async function patchDone(router: ReturnType<typeof createDefaultRouter>, issueID: number): Promise<Record<string, any>> {
  const response = await router.handle(new Request(`${BASE_URL}/api/issues/${issueID}`, {
    body: JSON.stringify({ status: "done" }),
    headers: { "content-type": "application/json" },
    method: "PATCH"
  }));
  expect(response.status).toBe(200);
  return response.json() as Promise<Record<string, any>>;
}

function postCommandEvidence(
  router: ReturnType<typeof createDefaultRouter>,
  issueID: number,
  body: Record<string, any>
): Promise<Response> {
  return router.handle(new Request(`${BASE_URL}/api/issues/${issueID}/evidence/command`, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "POST"
  }));
}

function postReadinessEvidence(
  router: ReturnType<typeof createDefaultRouter>,
  issueID: number,
  item: EvidenceRecord
): Promise<Response> {
  return router.handle(new Request(`${BASE_URL}/api/issues/${issueID}/evidence/readiness`, {
    body: JSON.stringify({ evidence: item }),
    headers: { "content-type": "application/json" },
    method: "POST"
  }));
}

function readinessEvidence(issueID: number, id: string): EvidenceRecord {
  const at = timestamp(20);
  return {
    artifact_refs: [{ kind: "report", ref: `release-report:${id}` }],
    completed_at: at,
    created_at: at,
    decisive_output: {
      facts: {
        environment: "production",
        migration_gate: "",
        readiness_event: "deployment",
        release_window: "W2",
        rollback_ref: "release:760:rollback",
        runtime_revision: "v0.1.0-760-g9f1e2d3",
        runtime_stamp: "20260720T000500Z-9f1e2d3-clean",
        source_revision: "9f1e2d3"
      },
      summary: "Production runtime stamp matches the source release"
    },
    id: `xw:evidence:issue_events:${id}`,
    kind: "http",
    observed_at: at,
    provenance: {
      assertion_origin: "system_observation",
      audit_event_ref: `release-audit:${id}`,
      producer: { id: "release-controller", kind: "system" },
      source_kind: "http_exchange",
      source_ref: `runtime:${id}`
    },
    redaction: { policy_ref: "evidence-redaction:v1", redacted_paths: [], status: "not_required" },
    revision: 0,
    schema_version: 1,
    status: "passed",
    updated_at: at,
    work_id: `xw:work:issues:${issueID}`
  };
}

function commandEvidenceBody(
  runID: string,
  channel: "delegated_executor" | "post_deploy_verifier",
  correlationID: string,
  exitCode: number,
  endedAt: string,
  overrides: { command?: string } = {}
): Record<string, any> {
  const ended = Date.parse(endedAt);
  return {
    channel,
    correlation_id: correlationID,
    kind: "test",
    observation: {
      command: overrides.command ?? "bun test smoke.test.ts",
      cwd: "/tmp/demo",
      duration_ms: 100,
      ended_at: new Date(ended).toISOString(),
      exit_code: exitCode,
      started_at: new Date(ended - 100).toISOString(),
      stderr: exitCode === 0 ? "" : "failed",
      stdout: exitCode === 0 ? "passed" : "",
      timed_out: false
    },
    producer_id: `${channel}:fixture`,
    run_id: runID,
    source_ref: `${channel}:${correlationID}`
  };
}

function timestamp(seconds: number): string {
  return new Date(Date.UTC(2026, 0, 1, 0, 0, seconds)).toISOString();
}

class ReadinessExecutionProvider implements ExecutorProvider {
  readonly capabilities = ["issue_execution"] as const;
  readonly id = "codex" as const;
  readonly inputs: ProviderRunInput[] = [];

  async run(input: ProviderRunInput): Promise<ProviderRunResult> {
    this.inputs.push(input);
    return { runId: `readiness-run-${input.issueId}` };
  }
}

function addReadinessDependency(db: RunnerDatabase, issueID: number, dependencyID: number): void {
  const source = getIssueAsWork(db, issueID);
  const target = getIssueAsWork(db, dependencyID);
  if (!source || !target) throw new Error("missing Work fixture");
  insertWorkRecord(db, source);
  insertWorkRecord(db, target);
  const relation: DependencyRelation = {
    actor: { id: "readiness-api-test", kind: "runner" },
    audit_event_ref: `readiness-api:${issueID}:${dependencyID}`,
    correlation_id: `readiness-api:${issueID}:${dependencyID}`,
    depends_on_work_id: target.id,
    kind: "depends_on",
    occurred_at: timestamp(5),
    reason: "readiness auto-wake dependency",
    relation_id: `depends-on:${issueID}:${dependencyID}`,
    work_id: source.id
  };
  insertWorkRelationRecord(db, "demo", relation);
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for readiness auto-run");
    await Bun.sleep(10);
  }
}
