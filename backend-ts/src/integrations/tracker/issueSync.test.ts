import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../../db/database.ts";
import { getIssue } from "../../db/repositories/issues.ts";
import { createFakeTrackerIssueAdapter } from "./fakeIssueAdapter.ts";
import { pollTrackerIssues, syncTrackerIssueEvent, trackerIssueFromPayload } from "./issueSync.ts";
import { createDefaultRouter, createRequestHandler } from "../../http/server.ts";

const roots: string[] = [];
const URL = "http://127.0.0.1:3008";

afterEach(async () => { while (roots.length) await rm(roots.pop()!, { recursive: true, force: true }); });

describe("Issue Tracker bidirectional sync", () => {
  test("fake tracker poll creates one intake, persists a cursor, and replays without another write", async () => {
    const database = await fixture();
    try {
      database.sqlite.run("insert into tracker_project_mappings (provider, scope, project_id, created_at, updated_at) values ('fake', 'demo', 'demo', '2026-07-18T00:00:00.000Z', '2026-07-18T00:00:00.000Z')");
      const event = fakeEvent("todo", "2026-07-18T01:00:00.000Z");
      const adapter = createFakeTrackerIssueAdapter([event], { position: "42", scope: "demo" });
      const first = await pollTrackerIssues(database, adapter);
      const replay = await pollTrackerIssues(database, adapter);
      expect(first.summary).toEqual({ conflicts: 0, replayed: 0, synced: 1 });
      expect(replay.summary).toEqual({ conflicts: 0, replayed: 1, synced: 1 });
      expect(database.sqlite.query("select count(*) as count from issues").get()).toEqual({ count: 1 });
      expect(database.sqlite.query("select position from tracker_sync_cursors where provider='fake' and scope='demo'").get()).toEqual({ position: "42" });
      expect(database.sqlite.query("select count(*) as count from external_links where source='fake' and external_type='tracker_issue'").get()).toEqual({ count: 1 });
      expect(database.sqlite.query("select count(*) as count from tracker_sync_events where action='intake_created'").get()).toEqual({ count: 1 });
    } finally { database.close(); }
  });

  test("external status never overwrites a newer user change and records the conflict", async () => {
    const database = await fixture();
    try {
      database.sqlite.run("insert into tracker_project_mappings (provider, scope, project_id, created_at, updated_at) values ('fake', 'demo', 'demo', '2026-07-18T00:00:00.000Z', '2026-07-18T00:00:00.000Z')");
      const created = syncTrackerIssueEvent(database, fakeEvent("todo", "2026-07-18T01:00:00.000Z"));
      database.sqlite.run("update issues set status='failed', updated_at='2026-07-18T02:00:00.000Z' where id=?", [created.issue_id!]);
      const conflict = syncTrackerIssueEvent(database, fakeEvent("closed", "2026-07-18T03:00:00.000Z"));
      expect(conflict).toMatchObject({ conflict: true, linked: true });
      expect(getIssue(database, created.issue_id!)?.status).toBe("failed");
      expect(database.sqlite.query("select action from tracker_sync_events order by id desc limit 1").get()).toEqual({ action: "local_conflict" });
    } finally { database.close(); }
  });

  test("normalizes GitHub, GitLab, and Linear webhook shapes through one intake contract", async () => {
    const database = await fixture();
    try {
      const router = createDefaultRouter({ database });
      const handle = createRequestHandler(router, "token");
      for (const [provider, scope, payload] of [
        ["github", "acme/demo", { issue: { id: 1, title: "GitHub issue", body: "body", state: "open", updated_at: "2026-07-18T01:00:00Z", html_url: "https://github.invalid/acme/demo/issues/1" }, repository: { full_name: "acme/demo" }, sender: { login: "octo" } }],
        ["gitlab", "acme/demo", { object_attributes: { id: 2, title: "GitLab issue", description: "body", state: "opened", updated_at: "2026-07-18T01:00:00Z", url: "https://gitlab.invalid/acme/demo/-/issues/2" }, project: { path_with_namespace: "acme/demo" }, user: { username: "gitlab" } }],
        ["linear", "eng", { data: { id: "lin-3", title: "Linear issue", description: "body", state: { type: "started" }, updatedAt: "2026-07-18T01:00:00Z", url: "https://linear.invalid/ENG-3", team: { key: "ENG" } }, actor: { name: "linear" } }]
      ] as const) {
        database.sqlite.run("insert into tracker_project_mappings (provider, scope, project_id, created_at, updated_at) values (?, ?, 'demo', '2026-07-18T00:00:00.000Z', '2026-07-18T00:00:00.000Z')", [provider, scope]);
        const response = await handle(new Request(`${URL}/api/integrations/trackers/${provider}/events`, { method: "POST", headers: { authorization: "Bearer token", "content-type": "application/json", "x-tracker-delivery": `${provider}-1` }, body: JSON.stringify(payload) }));
        expect(response.status).toBe(202);
      }
      expect(database.sqlite.query("select count(*) as count from issues").get()).toEqual({ count: 3 });
      expect(database.sqlite.query("select count(*) as count from tracker_issue_links").get()).toEqual({ count: 3 });
    } finally { database.close(); }
  });

  test("manual link is audited and lets a mapped external status update the selected Issue", async () => {
    const database = await fixture();
    try {
      const issue = database.sqlite.run(`insert into issues (project_id, title, description, status, priority, template_id, prompt_template,
        required_skill_intents_json, recommended_skill_intents_json, required_mcp_capabilities_json, recommended_mcp_capabilities_json,
        agent_profile_id, service_tier, source_session_id, source_turn_id, source_excerpt, workflow_snapshot_json, created_at, updated_at)
        values ('demo', 'Manual target', '', 'todo', 0, 'default', '{{issue.description}}', '[]', '[]', '[]', '[]', '', '', '', '', '', '{}',
        '2026-07-18T00:00:00.000Z', '2026-07-18T00:00:00.000Z')`);
      const issueID = Number(issue.lastInsertRowid);
      const handle = createRequestHandler(createDefaultRouter({ database }), "token");
      const linked = await handle(new Request(`${URL}/api/integrations/trackers/github/links`, { method: "PUT", headers: { authorization: "Bearer token", "content-type": "application/json" }, body: JSON.stringify({ external_id: "acme/demo:99", issue_id: issueID, audit: { actor: "operator", correlation_id: "manual-1", reason: "existing work" } }) }));
      expect(linked.status).toBe(201);
      const synced = syncTrackerIssueEvent(database, { actor: "octo", description: "", event_name: "issues", external_id: "acme/demo:99", external_status: "closed", external_updated_at: "2026-07-18T01:00:00.000Z", payload: { id: 99 }, provider: "github", scope: "acme/demo", title: "Manual target", url: "https://github.invalid/acme/demo/issues/99" });
      expect(synced).toMatchObject({ conflict: false, issue_id: issueID });
      expect(getIssue(database, issueID)?.status).toBe("done");
      expect(database.sqlite.query("select action from tracker_sync_events where action='manual_linked'").get()).toEqual({ action: "manual_linked" });
    } finally { database.close(); }
  });
});

function fakeEvent(status: string, updatedAt: string) { return { actor: "fake", cursor: { position: "1", scope: "demo" }, description: "Fake tracker intake", event_name: "issue", external_id: "demo:1", external_status: status, external_updated_at: updatedAt, payload: { id: 1, status }, provider: "fake" as const, scope: "demo", title: "Fake tracker issue", url: "https://fake.tracker.invalid/demo/1" }; }
async function fixture(): Promise<RunnerDatabase> { const root = await mkdtemp(join(tmpdir(), "codex-runner-tracker-sync-")); roots.push(root); const database = await openDatabase({ dbPath: join(root, "runner.sqlite") }); database.sqlite.run("insert into projects (id, name, cwd, created_at, updated_at) values ('demo', 'Demo', ?, '2026-07-18T00:00:00.000Z', '2026-07-18T00:00:00.000Z')", [root]); return database; }
