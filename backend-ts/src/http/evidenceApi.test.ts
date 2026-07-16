import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { EVIDENCE_RECORDED_EVENT_TYPE, recordEvidenceRecords } from "../db/repositories/evidence.ts";
import type { EvidenceRecord } from "../domain/evidence/contracts.ts";
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

      expect(passed).toMatchObject({ status: "done", error: "" });
      expect(failed).toMatchObject({ status: "failed", error: expect.stringContaining("Verification failed") });
      expect(passedBody.items).toEqual([
        expect.objectContaining({ kind: "test", run_id: passedRunID, status: "passed" })
      ]);
      expect(failedBody.items).toEqual([
        expect.objectContaining({
          decisive_summary: expect.stringContaining("failed with exit 1"),
          kind: "test",
          run_id: failedRunID,
          status: "failed"
        })
      ]);
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
      expect(await empty.json()).toMatchObject({ has_more: false, items: [], projection_errors: [] });
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
});

async function fixture(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-evidence-api-"));
  tempRoots.push(root);
  const db = await openDatabase({ stateDir: join(root, "state") });
  db.sqlite.run(
    `insert into projects (id, name, cwd, provider, created_at, updated_at)
     values ('demo', 'demo', '/tmp/demo', 'codex', ?, ?)`,
    [timestamp(0), timestamp(0)]
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

function timestamp(seconds: number): string {
  return new Date(Date.UTC(2026, 0, 1, 0, 0, seconds)).toISOString();
}
