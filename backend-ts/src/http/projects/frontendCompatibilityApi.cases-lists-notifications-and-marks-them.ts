import { expect, test } from "bun:test";
import { appendFile } from "node:fs/promises";
import { createDefaultRouter } from "../server.ts";
import type { TestFixture } from "./frontendCompatibilityApi.testFixture.ts";

export function registerListsNotificationsAndMarksThemCases(testScope: TestFixture) {
  const { openFixtureDatabase, requestJSON, usageProvider, insertNotification, tempDir, writeUsageJSONL } = testScope;
  test("lists notifications and marks them read", async () => {
      const { cwd, database } = await openFixtureDatabase();
      const router = createDefaultRouter({ database });
      await requestJSON(router, "/api/projects", "POST", { id: "demo", cwd }, 201);
      const issue = await requestJSON(router, "/api/issues", "POST", {
        project_id: "demo",
        status: "failed",
        title: "Needs user"
      }, 201);
      insertNotification(database, issue.id, "demo");
  
      const notifications = await requestJSON(router, "/api/notifications?project_id=demo&unread=1", "GET");
      const read = await requestJSON(router, `/api/notifications/${notifications[0].id}/read`, "POST", {});
      const unread = await requestJSON(router, "/api/notifications?project_id=demo&unread=1", "GET");
  
      expect(notifications).toMatchObject([
        { event: "pi.needs_user", issue_id: issue.id, project_id: "demo", read_at: "" }
      ]);
      expect(read).toMatchObject({ id: notifications[0].id, read_at: expect.any(String) });
      expect(read.read_at).not.toBe("");
      expect(unread).toEqual([]);
    });
  
  test("reads Codex usage from configured sessions dir", async () => {
      const { database } = await openFixtureDatabase();
      const sessionsDir = await tempDir("xuanwu-bun-sessions-");
      const usagePath = await writeUsageJSONL(sessionsDir, "2026/05/31/session.jsonl", [
        `{"timestamp":"2026-05-31T08:00:00Z","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":10,"output_tokens":5,"total_tokens":15}}}}`
      ]);
      const router = createDefaultRouter({
        database,
        codexSessionsDir: sessionsDir,
        providers: { codex: usageProvider("codex"), claude: usageProvider("claude") }
      });
  
      const usage = await requestJSON(router, "/api/usage/codex?refresh=1", "GET");
      const providerUsage = await requestJSON(router, "/api/usage/providers?compact=1&refresh=1", "GET");
  
      expect(usage).toMatchObject({
        source: sessionsDir,
        events_scanned: 1,
        pi_usage: {
          completeness: "complete",
          sessions_scanned: 0,
          status: "available",
          summary: { today: { total_tokens: 0 } }
        },
        summary: { all_time: { total_tokens: 15 } },
        latest_usage: { last_token_usage: { total_tokens: 15 } }
      });
      expect(providerUsage).toMatchObject({
        providers: [{
          compact: true,
          events_scanned: 1,
          provider: { id: "codex", scope: "local_sessions" },
          summary: { all_time: { total_tokens: 15 } }
        }, {
          events_scanned: 0,
          provider: { id: "claude", scope: "runner_attempts" },
          rate_limits: null
        }]
      });
  
      await appendFile(usagePath,
        `{"timestamp":"2026-05-31T09:00:00Z","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":4,"output_tokens":3,"total_tokens":7}}}}\n`);
      const refreshed = await requestJSON(router, "/api/usage/codex?compact=1&refresh=1", "GET");
      expect(refreshed).toMatchObject({
        compact: true,
        events_scanned: 2,
        project_usage: [],
        summary: { all_time: { total_tokens: 22 } }
      });
    });
}
