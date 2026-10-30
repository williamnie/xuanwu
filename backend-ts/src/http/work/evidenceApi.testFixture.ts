import { afterEach, expect } from "bun:test";
import { mkdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../../db/database.ts";
import { insertWorkRecord, insertWorkRelationRecord } from "../../db/repositories/workLedger.ts";
import type { EvidenceRecord } from "../../domain/evidence/contracts.ts";
import type { DependencyRelation } from "../../domain/work/contracts.ts";
import { getIssueAsWork } from "../../domain/work/issueAdapter.ts";
import type { ExecutorProvider, ProviderRunInput, ProviderRunResult } from "../../providers/types.ts";
import { createDefaultRouter } from "../server.ts";
import { useDatabaseCleanup } from "../../testing/harness.ts";



export function createTestFixture() {
  const trackDatabase = useDatabaseCleanup();

  const BASE_URL = "http://127.0.0.1:3008";

  const tempRoots: string[] = [];

  afterEach(async () => {
    while (tempRoots.length > 0) {
      const path = tempRoots.pop();
      if (path) await rm(path, { recursive: true, force: true });
    }
  });

  async function fixture(): Promise<RunnerDatabase> {
    const root = await mkdtemp(join(tmpdir(), "xuanwu-evidence-api-"));
    tempRoots.push(root);
    const db = await openDatabase({ stateDir: join(root, "state") }).then(trackDatabase);
    const project = join(root, "project");
    mkdirSync(project, { recursive: true });
    db.sqlite.run(
      `insert into projects (id, name, cwd, provider, created_at, updated_at)
     values ('demo', 'demo', ?, 'codex', ?, ?)`,
      [project, timestamp(0), timestamp(0)]
    );
    return db;
  }

  function insertIssue(db: RunnerDatabase, title: string, status: string, projectID = "demo"): number {
    db.sqlite.run(
      "insert into issues (project_id, title, status, created_at, updated_at) values (?, ?, ?, ?, ?)",
      [projectID, title, status, timestamp(0), timestamp(0)]
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

  function addReadinessDependency(db: RunnerDatabase, issueID: number, dependencyID: number, projectID = "demo"): void {
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
    insertWorkRelationRecord(db, projectID, relation);
  }

  async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      if (Date.now() >= deadline) throw new Error("timed out waiting for readiness auto-run");
      await Bun.sleep(10);
    }
  }
  return { trackDatabase, BASE_URL, tempRoots, fixture, insertIssue, insertRun, evidence, insertCommandEvent, patchDone, postCommandEvidence, postReadinessEvidence, readinessEvidence, commandEvidenceBody, timestamp, ReadinessExecutionProvider, addReadinessDependency, waitFor };
}
export type TestFixture = ReturnType<typeof createTestFixture>;
