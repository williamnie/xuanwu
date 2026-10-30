import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { EVIDENCE_RECORDED_EVENT_TYPE, listStoredEvidence, recordEvidenceRecords } from "../../db/repositories/evidence.ts";
import { createDefaultRouter, createRequestHandler } from "../server.ts";
import type { TestFixture } from "./evidenceApi.testFixture.ts";

export function registerPaginatesBoundedSummariesAndProvidesCases(testScope: TestFixture) {
  const { BASE_URL, fixture, insertIssue, insertRun, evidence, insertCommandEvent, patchDone, postCommandEvidence, postReadinessEvidence, readinessEvidence, commandEvidenceBody, timestamp } = testScope;
  test("paginates bounded summaries and provides full detail plus authenticated artifact bytes", async () => {
      const db = await fixture();
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
    });
  
  test("does not synthesize Evidence from legacy command logs", async () => {
      const db = await fixture();
      const passedIssueID = insertIssue(db, "Passing Work", "in_progress");
      const failedIssueID = insertIssue(db, "Failing Work", "in_progress");
      const passedRunID = insertRun(db, passedIssueID, "in_progress", "session-pass");
      const failedRunID = insertRun(db, failedIssueID, "in_progress", "session-fail");
      insertCommandEvent(db, passedIssueID, "bun test src/http/work/evidenceApi.test.ts", 0);
      insertCommandEvent(db, failedIssueID, "bun test src/http/work/evidenceApi.test.ts", 1);
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
  
      expect(passed).toMatchObject({
        status: "in_progress",
        error: ""
      });
      expect(failed).toMatchObject({ status: "in_progress", error: "" });
      expect(passedBody.items).toEqual([]);
      expect(failedBody.items).toEqual([]);
      expect(passedBody.compatibility).toMatchObject({ fallback_applied: false, fallback_sources: [] });
      expect(failedBody.compatibility).toMatchObject({ fallback_applied: false, fallback_sources: [] });
      expect(db.sqlite.query<{ count: number }, [string]>(
        "select count(*) as count from issue_events where type=?"
      ).get(EVIDENCE_RECORDED_EVENT_TYPE)?.count).toBe(0);
    });
  
  test("returns explicit empty and invalid-request states without projecting unrelated Issues", async () => {
      const db = await fixture();
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
        projection_errors: []
      });
      expect(badCursor.status).toBe(400);
      expect(await badCursor.json()).toEqual({ code: "invalid_cursor", message: "Evidence cursor is invalid" });
      expect(missing.status).toBe(404);
      expect(await missing.json()).toEqual({ code: "evidence_not_found", message: "Evidence not found" });
    });
  
  test("does not apply the retired W1 command projection fallback", async () => {
      const db = await fixture();
      const issueID = insertIssue(db, "Legacy projected Evidence", "in_progress");
      insertRun(db, issueID, "in_progress", "session-legacy");
      insertCommandEvent(db, issueID, "bun test src/http/work/evidenceApi.test.ts", 0);
      const router = createDefaultRouter({ database: db });
  
      const response = await router.handle(new Request(`${BASE_URL}/api/evidence?issue_id=${issueID}`));
      const body = await response.json() as Record<string, any>;
      expect(response.status).toBe(200);
      expect(body).toMatchObject({
        compatibility: { fallback_applied: false, fallback_sources: [] },
        items: []
      });
      expect(db.sqlite.query<{ count: number }, [string]>(
        "select count(*) as count from issue_events where type=?"
      ).get(EVIDENCE_RECORDED_EVENT_TYPE)?.count).toBe(0);
    });
  
  test("rejects writes to the retired command Evidence compatibility endpoint", async () => {
      const db = await fixture();
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
  
      expect([failedResponse, passedResponse, replay, conflict, crossRun].map((response) => response.status))
        .toEqual([404, 404, 404, 404, 404]);
      expect(completed).toMatchObject({
        status: "in_progress",
        error: ""
      });
      expect(records).toEqual([]);
    });
  
  test("records strict runtime readiness Evidence append-only and rejects missing rollback provenance", async () => {
      const db = await fixture();
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
    });
}
