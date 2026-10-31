import { expect, test } from "bun:test";
import { dirname } from "node:path";
import { buildConfig } from "../../config/env.ts";
import { getIssue } from "../../db/repositories/issues.ts";
import { createPiAction } from "../../db/repositories/pi.ts";
import { dispatchPiAction } from "./piActionDispatch.ts";
import type { TestFixture } from "./piActionDispatch.testFixture.ts";

export function registerResumeFollowUpRevalidatesHarmlessCases(testScope: TestFixture) {
  const { fixtureDb, insertProject, insertIssue, insertIssueRunSession, SupervisorProvider, waitUntil } = testScope;
  test("resume follow-up revalidates harmless timestamp drift before continuing", async () => {
      const db = await fixtureDb();
      const provider = new SupervisorProvider();
      insertProject(db, "demo");
      insertIssueRunSession(db, { issueID: 308, projectID: "demo", sessionID: "thread-308", turnID: "turn-old" });
      const action = createPiAction(db, {
        action_type: "session.resume_followup",
        id: "stale-resume-action",
        issue_id: 308,
        payload_json: JSON.stringify({
          expected_issue_updated_at: "2026-06-10T06:59:00Z",
          expected_provider_turn_id: "turn-old",
          expected_run_id: "issue-308-attempt-1",
          expected_session_updated_at: "2026-06-10T07:01:00Z",
          issue_id: 308,
          prompt: "continue",
          provider: "codex",
          provider_session_id: "thread-308"
        }),
        project_id: "demo",
        status: "approved"
      });
  
      db.sqlite.run("update issues set updated_at=? where id=308", ["2026-06-10T07:02:00Z"]);
      db.sqlite.run("update agent_sessions set updated_at=? where session_key=?", [
        "2026-06-10T07:03:00Z", "codex:thread-308"
      ]);
  
      await expect(dispatchPiAction({ database: db, providers: { codex: provider } }, action))
        .resolves.toMatchObject({ turn_id: "turn-followup" });
      expect(provider.calls).toEqual([{ prompt: "continue", sessionId: "thread-308" }]);
    });
  
  test("resume follow-up still refuses a changed run or provider turn", async () => {
      const db = await fixtureDb();
      const provider = new SupervisorProvider();
      insertProject(db, "demo");
      insertIssueRunSession(db, { issueID: 310, projectID: "demo", sessionID: "thread-310", turnID: "turn-old" });
      db.sqlite.run(`update issue_runs set provider_turn_id='turn-new' where issue_id=310`);
      db.sqlite.run(`update agent_sessions set raw_ref=? where session_key='codex:thread-310'`, [
        JSON.stringify({ provider_turn_id: "turn-new" })
      ]);
      const action = createPiAction(db, {
        action_type: "session.resume_followup",
        id: "changed-turn-resume-action",
        issue_id: 310,
        payload_json: JSON.stringify({
          expected_issue_updated_at: "2026-06-10T07:00:00Z",
          expected_provider_turn_id: "turn-old",
          expected_run_id: "issue-310-attempt-1",
          expected_session_updated_at: "2026-06-10T07:01:00Z",
          issue_id: 310,
          prompt: "continue",
          provider: "codex",
          provider_session_id: "thread-310"
        }),
        project_id: "demo",
        status: "approved"
      });
  
      await expect(dispatchPiAction({ database: db, providers: { codex: provider } }, action))
        .resolves.toMatchObject({ skipped: true });
      expect(provider.calls).toEqual([]);
    });
  
  test("issue.delete permanently removes an approved non-running batch", async () => {
      const db = await fixtureDb();
      insertProject(db, "demo");
      insertIssue(db, { issueID: 901, projectID: "demo", status: "triage" });
      insertIssue(db, { issueID: 902, projectID: "demo", status: "cancelled" });
      const action = createPiAction(db, {
        action_type: "issue.delete",
        id: "delete-issue-batch",
        payload_json: JSON.stringify({ issue_ids: [901, 902], reason: "用户确认删除" }),
        project_id: "demo",
        status: "approved"
      });
  
      await expect(dispatchPiAction({ database: db }, action))
        .resolves.toEqual({ deleted_issue_ids: [901, 902] });
      expect(getIssue(db, 901)).toBeNull();
      expect(getIssue(db, 902)).toBeNull();
    });
  
  test("runner settings update and supervised restart dispatch through approved PI actions", async () => {
      const db = await fixtureDb();
      let restarted = 0;
      const config = buildConfig({ dbPath: db.path, stateDir: dirname(db.path) });
      const settingsAction = createPiAction(db, {
        action_type: "runner.settings_update",
        id: "runner-settings-update",
        payload_json: JSON.stringify({ max_parallel_projects: 3, reason: "提高并发" }),
        status: "approved"
      });
      const restartAction = createPiAction(db, {
        action_type: "system.restart",
        id: "runner-system-restart",
        payload_json: JSON.stringify({ reason: "应用运行配置" }),
        status: "approved"
      });
  
      await expect(dispatchPiAction({ config, database: db }, settingsAction))
        .resolves.toMatchObject({ max_parallel_projects: 3 });
      expect(config.runner.maxParallelProjects).toBe(3);
      await expect(dispatchPiAction({
        database: db,
        restartDelayMs: 0,
        restartProcess: () => { restarted += 1; },
        supervisorManaged: true
      }, restartAction)).resolves.toMatchObject({ restart_scheduled: true });
      await waitUntil(() => restarted === 1);
    });
}
