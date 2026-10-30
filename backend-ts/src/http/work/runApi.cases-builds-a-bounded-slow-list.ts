import { expect, test } from "bun:test";
import { upsertAgentSession } from "../../db/repositories/agentSessions.ts";
import { slowRunListLogEntry } from "./runApi.ts";
import { createDefaultRouter } from "../server.ts";
import type { TestFixture } from "./runApi.testFixture.ts";

export function registerBuildsABoundedSlowListCases(testScope: TestFixture) {
  const { BASE_URL, openFixtureDatabase, insertProject, insertIssue, insertRun, PiRunDetailProvider, timestamp, insertTranscriptMessage } = testScope;
  test("builds a bounded slow-list diagnostic without exposing filter values", () => {
      const request = new Request(
        `${BASE_URL}/api/runs?project_id=private-project&work_id=secret-work&provider=codex&status=failed&page=2&page_size=30`
      );
  
      expect(slowRunListLogEntry(request, 120, 200)).toBeUndefined();
      const entry = slowRunListLogEntry(request, 1250.44, 200);
      expect(entry).toEqual({
        duration_ms: 1250,
        event: "runner.run_list_slow",
        page: 2,
        page_size: 30,
        project_filter: true,
        provider_filter_count: 1,
        status: 200,
        status_filter_count: 1,
        work_filter: true
      });
      expect(JSON.stringify(entry)).not.toContain("private-project");
      expect(JSON.stringify(entry)).not.toContain("secret-work");
    });
  
  test("exposes a Pi Run session reference and provider-neutral transcript drill-down", async () => {
      const db = await openFixtureDatabase();
      const provider = new PiRunDetailProvider();
      insertProject(db, "demo");
      const issueID = insertIssue(db, "demo", "Pi transcript", "failed");
      const runID = insertRun(db, issueID, "failed", {
        endedAt: timestamp(2),
        provider: "pi-coding-agent",
        sessionID: "pi-session-1",
        startedAt: timestamp(1)
      });
      upsertAgentSession(db, {
        issue_id: issueID,
        project_id: "demo",
        provider: "pi-coding-agent",
        provider_session_id: "pi-session-1",
        status: "failed"
      });
      const router = createDefaultRouter({ database: db, providers: { "pi-coding-agent": provider } });
  
      const runResponse = await router.handle(new Request(`${BASE_URL}/api/runs/${encodeURIComponent(runID)}`));
      const runBody = await runResponse.json() as Record<string, any>;
      const sessionRef = runBody.run.attempts[0].provider_ref.observation_ref;
      const sessionResponse = await router.handle(new Request(
        `${BASE_URL}/api/sessions/${encodeURIComponent(sessionRef)}`
      ));
      const turnsResponse = await router.handle(new Request(
        `${BASE_URL}/api/sessions/${encodeURIComponent(sessionRef)}/turns?items_view=summary&limit=20`
      ));
  
      expect(runResponse.status).toBe(200);
      expect(runBody.run).toMatchObject({
        provider: "pi-coding-agent",
        attempts: [{
          agent_session_key: "pi-coding-agent:pi-session-1",
          links: { provider_session: expect.stringContaining("pi-coding-agent%3Api-session-1") },
          provider_ref: {
            observation_ref: "pi-coding-agent:pi-session-1",
            provider: "pi-coding-agent",
            session_ref: "pi-session-1"
          }
        }]
      });
      expect(sessionResponse.status).toBe(200);
      expect(await sessionResponse.json()).toMatchObject({
        id: "pi-coding-agent:pi-session-1",
        provider: "pi-coding-agent",
        turns: []
      });
      expect(turnsResponse.status).toBe(200);
      expect(await turnsResponse.json()).toMatchObject({
        data: [{ items: [
          { type: "userMessage" },
          { type: "reasoning" },
          { type: "agentMessage" },
          { type: "custom_tool_call" },
          { type: "custom_tool_call_output" }
        ] }]
      });
    });
  
  test("returns bounded agent messages for the selected Run Attempt without loading full provider history", async () => {
      const db = await openFixtureDatabase();
      insertProject(db, "demo");
      const issueID = insertIssue(db, "demo", "Codex transcript", "in_progress");
      const runID = insertRun(db, issueID, "in_progress", {
        provider: "codex",
        sessionID: "thread-transcript",
        startedAt: timestamp(1),
        turnID: "turn-transcript"
      });
      const attemptID = db.sqlite.query<{ attempt_id: string }, [string]>(
        "select attempt_id from run_attempts where run_id=?"
      ).get(runID)?.attempt_id ?? "";
      insertTranscriptMessage(db, issueID, runID, attemptID, 2, "commentary-1", "commentary", "我先检查当前实现。");
      insertTranscriptMessage(db, issueID, runID, attemptID, 3, "final-1", "final_answer", "修复完成。");
      insertTranscriptMessage(db, issueID, runID, `${attemptID}-other`, 4, "other", "commentary", "其他 Attempt");
      const router = createDefaultRouter({ database: db });
  
      const response = await router.handle(new Request(
        `${BASE_URL}/api/runs/${encodeURIComponent(runID)}/transcript?attempt_id=${encodeURIComponent(attemptID)}&limit=20`
      ));
      const body = await response.json() as Record<string, any>;
      const latestPage = await router.handle(new Request(
        `${BASE_URL}/api/runs/${encodeURIComponent(runID)}/transcript?attempt_id=${encodeURIComponent(attemptID)}&limit=1`
      ));
      const latestBody = await latestPage.json() as Record<string, any>;
      const olderPage = await router.handle(new Request(
        `${BASE_URL}/api/runs/${encodeURIComponent(runID)}/transcript?attempt_id=${encodeURIComponent(attemptID)}&limit=1&before_id=${latestBody.nextCursor}`
      ));
  
      expect(response.status).toBe(200);
      expect(body).toMatchObject({
        data: [
          { id: "commentary-1", phase: "commentary", provider_turn_id: "turn-transcript", text: "我先检查当前实现。", type: "agentMessage" },
          { id: "final-1", phase: "final_answer", provider_turn_id: "turn-transcript", text: "修复完成。", type: "agentMessage" }
        ],
        nextCursor: ""
      });
      expect(JSON.stringify(body)).not.toContain("其他 Attempt");
      expect(latestBody).toMatchObject({ data: [{ id: "final-1" }], nextCursor: expect.any(String) });
      expect(await olderPage.json()).toMatchObject({ data: [{ id: "commentary-1" }], nextCursor: "" });
    });
  
  test("lists and details a large Run set with bounded pagination and dimension filters", async () => {
      const db = await openFixtureDatabase();
      insertProject(db, "demo");
      insertProject(db, "other");
      for (let index = 1; index <= 125; index += 1) {
        const issueID = insertIssue(db, "demo", `Work ${String(index).padStart(3, "0")}`, "done");
        insertRun(db, issueID, "succeeded", {
          endedAt: timestamp(index + 200),
          sessionID: `session-${index}`,
          startedAt: timestamp(index),
          turnID: `turn-${index}`
        });
      }
      const otherIssueID = insertIssue(db, "other", "Other Work", "failed");
      insertRun(db, otherIssueID, "failed", { endedAt: timestamp(500), startedAt: timestamp(499) });
      const router = createDefaultRouter({ database: db });
  
      const response = await router.handle(new Request(
        `${BASE_URL}/api/runs?project_id=demo&provider=codex&status=succeeded&sort=created_at&order=asc&page=3&page_size=50`
      ));
      const body = await response.json() as Record<string, any>;
      const invalidPage = await router.handle(new Request(`${BASE_URL}/api/runs?page_size=101`));
      const missingProject = await router.handle(new Request(`${BASE_URL}/api/runs?project_id=missing`));
      const runID = String(body.items[0]?.id);
      const workID = String(body.items[0]?.work_id);
      const workFiltered = await router.handle(new Request(
        `${BASE_URL}/api/runs?work_id=${encodeURIComponent(workID)}`
      ));
      const detail = await router.handle(new Request(`${BASE_URL}/api/runs/${encodeURIComponent(runID)}`));
      const detailBody = await detail.json() as Record<string, any>;
  
      expect(response.status).toBe(200);
      expect(body).toMatchObject({
        page: 3,
        page_size: 50,
        total: 125,
        total_pages: 3
      });
      expect(body.items).toHaveLength(25);
      expect(body).not.toHaveProperty("compatibility");
      expect(body.items[0]).not.toHaveProperty("legacy");
      expect(body.items[0]).toMatchObject({
        attempt_count: 1,
        progress: { attempt_status: "succeeded", phase: "succeeded", projection_mode: "list_summary" },
        project_id: "demo",
        provider: "codex",
        status: "succeeded",
        trigger: "initial"
      });
      expect(invalidPage.status).toBe(400);
      expect(await invalidPage.json()).toEqual({ code: "invalid_request", message: "page_size must not exceed 100" });
      expect(missingProject.status).toBe(404);
      expect(workFiltered.status).toBe(200);
      expect(await workFiltered.json()).toMatchObject({ items: [{ id: runID, work_id: workID }], total: 1 });
      expect(detail.status).toBe(200);
      expect(detailBody.run).toMatchObject({
        attempts: [{
          kind: "initial",
          links: { provider_session: expect.stringContaining("/api/sessions/") },
          provider_ref: { session_ref: expect.any(String), turn_ref: expect.any(String) },
          status: "succeeded"
        }],
        cost: { usage: { completeness: "unavailable" } },
        links: {
          evidence: expect.stringContaining("/api/evidence?run_id="),
          lifecycle_audit: expect.stringContaining("run.lifecycle.intent.v1"),
          logs: expect.stringContaining("type=issue.log")
        }
      });
      expect(detailBody.run.progress.projection_mode).toBe("read_through_rebuild");
      expect(detailBody).not.toHaveProperty("compatibility");
      expect(detailBody.run).not.toHaveProperty("legacy");
    });
}
