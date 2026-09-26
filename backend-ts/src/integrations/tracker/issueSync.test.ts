import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../../db/database.ts";
import { createIssue } from "../../db/repositories/issueCreate.ts";
import { getIssue } from "../../db/repositories/issues.ts";
import { getTrackerIssueLink, upsertTrackerIssueLink, upsertTrackerProjectMapping } from "../../db/repositories/trackerIssueSync.ts";
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

  test("manual GitHub link is audited and preserves the selected Issue status", async () => {
    const database = await fixture();
    try {
      const issue = database.sqlite.run(`insert into issues (project_id, title, description, status, priority,
        required_skill_intents_json, recommended_skill_intents_json, required_mcp_capabilities_json, recommended_mcp_capabilities_json,
        agent_profile_id, service_tier, source_session_id, source_turn_id, source_excerpt, workflow_snapshot_json, created_at, updated_at)
        values ('demo', 'Manual target', '', 'todo', 0, '[]', '[]', '[]', '[]', '', '', '', '', '', '{}',
        '2026-07-18T00:00:00.000Z', '2026-07-18T00:00:00.000Z')`);
      const issueID = Number(issue.lastInsertRowid);
      const handle = createRequestHandler(createDefaultRouter({ database }), "token");
      const linked = await handle(new Request(`${URL}/api/integrations/trackers/github/links`, { method: "PUT", headers: { authorization: "Bearer token", "content-type": "application/json" }, body: JSON.stringify({ external_id: "acme/demo:99", issue_id: issueID, audit: { actor: "operator", correlation_id: "manual-1", reason: "existing work" } }) }));
      expect(linked.status).toBe(201);
      const synced = syncTrackerIssueEvent(database, { actor: "octo", description: "", event_name: "issues", external_id: "acme/demo:99", external_status: "closed", external_updated_at: "2026-07-18T01:00:00.000Z", payload: { id: 99 }, provider: "github", scope: "acme/demo", title: "Manual target", url: "https://github.invalid/acme/demo/issues/99" });
      expect(synced).toMatchObject({ conflict: false, issue_id: issueID });
      expect(getIssue(database, issueID)?.status).toBe("todo");
      expect(database.sqlite.query("select action from tracker_sync_events where action='manual_linked'").get()).toEqual({ action: "manual_linked" });
      expect(database.sqlite.query("select action from tracker_sync_events order by id desc limit 1").get()).toEqual({ action: "external_status_recorded" });
    } finally { database.close(); }
  });

  for (const action of ["closed", "reopened"] as const) {
    test.each(["triage", "todo", "in_progress", "needs_user", "done", "failed", "cancelled"])(`GitHub ${action} records external facts and preserves local %s`, async (status) => {
      const database = await fixture();
      try {
        const issue = linkedGitHubIssue(database, status);
        const event = githubEvent(action, "2026-07-18T01:00:00.000Z");
        const result = syncTrackerIssueEvent(database, event);
        expect(result).toMatchObject({ conflict: false, issue_id: issue.id, linked: true, replayed: false });
        expect(getIssue(database, issue.id)).toEqual(issue);
        expect(result.event.normalized_message.external_status).toBe(action === "closed" ? "closed" : "open");
        expect(result.event.raw_json.action).toBe(action);
        expect(getTrackerIssueLink(database, "github", event.external_id)).toMatchObject({
          last_external_updated_at: event.external_updated_at, last_synced_issue_updated_at: issue.updated_at
        });
        expect(database.sqlite.query("select action, detail_json from tracker_sync_events where issue_id=?").all(issue.id)).toEqual([
          { action: "external_status_recorded", detail_json: JSON.stringify({ external_status: event.external_status, issue_status: status }) }
        ]);
        expect(database.sqlite.query("select relationship from external_links where issue_id=?").all(issue.id)).toEqual([{ relationship: "external_status_recorded" }]);
        expect(database.sqlite.query("select type from issue_events where issue_id=?").all(issue.id)).toEqual([{ type: "issue.created" }]);
        expect(database.sqlite.query("select count(*) as count from issue_runs").get()).toEqual({ count: 0 });
        expect(database.sqlite.query("select count(*) as count from pi_actions").get()).toEqual({ count: 0 });
      } finally { database.close(); }
    });
  }

  test("GitHub facts preserve newer local edits and the local sync checkpoint", async () => {
    const database = await fixture();
    try {
      const issue = linkedGitHubIssue(database, "todo");
      database.sqlite.run("update issues set status='in_progress', updated_at='2026-07-18T02:00:00.000Z' where id=?", [issue.id]);
      const before = getIssue(database, issue.id);
      const event = githubEvent("closed", "2026-07-18T03:00:00.000Z");
      expect(syncTrackerIssueEvent(database, event)).toMatchObject({ conflict: false, linked: true });
      expect(getIssue(database, issue.id)).toEqual(before);
      expect(getTrackerIssueLink(database, "github", event.external_id)).toMatchObject({
        last_external_updated_at: event.external_updated_at, last_synced_issue_updated_at: issue.updated_at
      });
      expect(database.sqlite.query("select action from tracker_sync_events order by id desc limit 1").get()).toEqual({ action: "external_status_recorded" });
    } finally { database.close(); }
  });

  test("GitHub closed intake starts in triage through webhook and remains triage after poll reopen and replay", async () => {
    const database = await fixture();
    try {
      upsertTrackerProjectMapping(database, { provider: "github", scope: "acme/demo", project_id: "demo" });
      const handle = createRequestHandler(createDefaultRouter({ database }), "token");
      const event = githubEvent("closed", "2026-07-18T01:00:00.000Z");
      for (const expectedStatus of [202, 200]) {
        const response = await handle(new Request(`${URL}/api/integrations/trackers/github/events`, {
          method: "POST", headers: { authorization: "Bearer token", "content-type": "application/json", "x-github-delivery": "github-closed" }, body: JSON.stringify(event.payload)
        }));
        expect(response.status).toBe(expectedStatus);
        const result = await response.json();
        expect(result).toMatchObject({ accepted: true, conflict: false, linked: true, replayed: expectedStatus === 200 });
        expect(getIssue(database, result.issue_id)).toMatchObject({ status: "triage", attempt_count: 0 });
        expect(result.event.normalized_message.external_status).toBe("closed");
      }
      const reopened = githubEvent("reopened", event.external_updated_at);
      for (const replayed of [0, 1]) {
        const response = await handle(new Request(`${URL}/api/integrations/trackers/github/poll`, {
          method: "POST", headers: { authorization: "Bearer token", "content-type": "application/json" },
          body: JSON.stringify({ events: [{ payload: reopened.payload, event_name: "issues", cursor: "github-reopened" }] })
        }));
        expect(response.status).toBe(202);
        expect((await response.json()).summary).toEqual({ conflicts: 0, replayed, synced: 1 });
      }
      expect(database.sqlite.query("select status from issues").all()).toEqual([{ status: "triage" }]);
      expect(database.sqlite.query("select action from tracker_sync_events order by id").all()).toEqual([{ action: "intake_created" }, { action: "external_status_recorded" }]);
      expect(database.sqlite.query("select type from issue_events").all()).toEqual([{ type: "issue.created" }]);
      expect(database.sqlite.query("select count(*) as count from external_events").get()).toEqual({ count: 2 });
      expect(database.sqlite.query("select count(*) as count from external_links").get()).toEqual({ count: 2 });
      expect(database.sqlite.query("select position from tracker_sync_cursors where provider='github'").get()).toEqual({ position: "github-reopened" });
    } finally { database.close(); }
  });

  test("GitHub closed then reopened preserves todo, replay dedupe, stale protection, and cursor progress", async () => {
    const database = await fixture();
    try {
      const issue = linkedGitHubIssue(database, "todo");
      const closed = githubEvent("closed", "2026-07-18T02:00:00.000Z");
      const closedResult = syncTrackerIssueEvent(database, closed);
      expect(getIssue(database, issue.id)).toEqual(issue);
      const reopened = githubEvent("reopened", "2026-07-18T03:00:00.000Z");
      const reopenedResult = syncTrackerIssueEvent(database, reopened);
      expect(reopenedResult).toMatchObject({ conflict: false, replayed: false });
      expect(reopenedResult.event.id).not.toBe(closedResult.event.id);
      expect(database.sqlite.query("select normalized_message_json, raw_json from external_events order by id").all()).toEqual([
        { normalized_message_json: JSON.stringify(closedResult.event.normalized_message), raw_json: JSON.stringify(closed.payload) },
        { normalized_message_json: JSON.stringify(reopenedResult.event.normalized_message), raw_json: JSON.stringify(reopened.payload) }
      ]);
      expect(closedResult.event.normalized_message.external_status).toBe("closed");
      expect(reopenedResult.event.normalized_message.external_status).toBe("open");
      expect(getIssue(database, issue.id)).toEqual(issue);
      expect(syncTrackerIssueEvent(database, { ...reopened, cursor: { position: "replay-cursor", scope: "acme/demo" } })).toMatchObject({ conflict: false, replayed: true, event: { id: reopenedResult.event.id } });
      expect(database.sqlite.query("select position from tracker_sync_cursors where provider='github'").get()).toEqual({ position: "replay-cursor" });
      const edited = { ...reopened, payload: { ...reopened.payload, action: "edited" } };
      const editedResult = syncTrackerIssueEvent(database, edited);
      expect(editedResult).toMatchObject({ conflict: false, replayed: false });
      expect(editedResult.event.id).not.toBe(reopenedResult.event.id);
      expect(syncTrackerIssueEvent(database, edited)).toMatchObject({ replayed: true, event: { id: editedResult.event.id } });
      const stale = githubEvent("closed", "2026-07-18T01:00:00.000Z");
      expect(syncTrackerIssueEvent(database, stale)).toMatchObject({ conflict: true, replayed: false });
      expect(getIssue(database, issue.id)).toEqual(issue);
      expect(getTrackerIssueLink(database, "github", reopened.external_id)?.last_external_updated_at).toBe(reopened.external_updated_at);
      expect(database.sqlite.query("select action from tracker_sync_events order by id").all()).toEqual([
        { action: "external_status_recorded" }, { action: "external_status_recorded" }, { action: "external_status_recorded" }, { action: "stale_external" }
      ]);
      expect(database.sqlite.query("select count(*) as count from external_events").get()).toEqual({ count: 4 });
      expect(database.sqlite.query("select count(*) as count from external_links").get()).toEqual({ count: 4 });
      expect(database.sqlite.query("select type from issue_events").all()).toEqual([{ type: "issue.created" }]);
    } finally { database.close(); }
  });

  test.each(["webhook", "poll"] as const)("GitHub %s preserves distinct same-timestamp payloads and replays each event", async (trigger) => {
    const database = await fixture();
    try {
      const issue = linkedGitHubIssue(database, "todo");
      const closed = githubEvent("closed", "2026-07-18T02:00:00.000Z");
      const reopened = githubEvent("reopened", closed.external_updated_at);
      const events = [closed, reopened, ...["Edited title", "Edited again"].map((title) => trackerIssueFromPayload("github", {
        ...reopened.payload, action: "edited", issue: { ...reopened.payload.issue as Record<string, unknown>, title }
      }, "issues"))];
      const results = events.map((event) => syncTrackerIssueEvent(database, { ...event, cursor: undefined }, trigger));
      for (const result of results) expect(result).toMatchObject({ conflict: false, issue_id: issue.id, linked: true, replayed: false });
      expect(new Set(results.map((result) => result.event.id)).size).toBe(4);
      expect(new Set(results.map((result) => result.event.dedupe_key)).size).toBe(4);
      expect(database.sqlite.query("select raw_json from external_events order by id").all()).toEqual(events.map((event) => ({ raw_json: JSON.stringify(event.payload) })));
      expect(results.map((result) => result.event.normalized_message.external_status)).toEqual(["closed", "open", "open", "open"]);
      for (const [index, event] of events.entries()) {
        expect(syncTrackerIssueEvent(database, { ...event, cursor: { position: `replay-${index}`, scope: event.scope } }, trigger)).toMatchObject({
          conflict: false, issue_id: issue.id, linked: true, replayed: true, event: { id: results[index]!.event.id }
        });
      }
      expect(getIssue(database, issue.id)).toEqual(issue);
      expect(getTrackerIssueLink(database, "github", closed.external_id)).toMatchObject({
        last_external_updated_at: closed.external_updated_at, last_synced_issue_updated_at: issue.updated_at
      });
      expect(database.sqlite.query("select action from tracker_sync_events order by id").all()).toEqual(events.map(() => ({ action: "external_status_recorded" })));
      expect(database.sqlite.query("select count(*) as count from external_events").get()).toEqual({ count: 4 });
      expect(database.sqlite.query("select count(*) as count from external_links").get()).toEqual({ count: 4 });
      expect(database.sqlite.query("select position from tracker_sync_cursors where provider='github'").get()).toEqual({ position: "replay-3" });
      expect(database.sqlite.query("select type from issue_events").all()).toEqual([{ type: "issue.created" }]);
    } finally { database.close(); }
  });

  test("GitHub replays legacy timestamp keys while accepting different same-timestamp payloads", async () => {
    const database = await fixture();
    try {
      const issue = linkedGitHubIssue(database, "todo");
      const closed = githubEvent("closed", "2026-07-18T02:00:00.000Z");
      const first = syncTrackerIssueEvent(database, closed);
      database.sqlite.run("update external_events set dedupe_key=? where id=?", [`github:${closed.external_id}:${closed.external_updated_at}`, first.event.id]);
      const reopened = syncTrackerIssueEvent(database, githubEvent("reopened", closed.external_updated_at));
      expect(reopened).toMatchObject({ conflict: false, replayed: false });
      expect(reopened.event.id).not.toBe(first.event.id);
      expect(syncTrackerIssueEvent(database, closed)).toMatchObject({ conflict: false, replayed: true, event: { id: first.event.id } });
      expect(getIssue(database, issue.id)).toEqual(issue);
      expect(database.sqlite.query("select count(*) as count from external_events").get()).toEqual({ count: 2 });
      expect(database.sqlite.query("select count(*) as count from external_links").get()).toEqual({ count: 2 });
      expect(database.sqlite.query("select count(*) as count from tracker_sync_events").get()).toEqual({ count: 2 });
    } finally { database.close(); }
  });

  test.each(["fake", "gitlab", "linear"] as const)("%s retains closed intake and linked status mapping", async (provider) => {
    const database = await fixture();
    try {
      upsertTrackerProjectMapping(database, { provider, scope: "demo", project_id: "demo" });
      const first = syncTrackerIssueEvent(database, { ...fakeEvent("closed", "2026-07-18T01:00:00.000Z"), provider });
      expect(getIssue(database, first.issue_id!)?.status).toBe("done");
      expect(syncTrackerIssueEvent(database, { ...fakeEvent("closed", "2026-07-18T01:00:00.000Z"), provider })).toMatchObject({ replayed: true });
      expect(() => syncTrackerIssueEvent(database, { ...fakeEvent("open", "2026-07-18T01:00:00.000Z"), provider })).toThrow("tracker_event_dedupe_conflict");
      const reopened = syncTrackerIssueEvent(database, { ...fakeEvent("open", "2026-07-18T02:00:00.000Z"), provider });
      expect(reopened.conflict).toBe(false);
      expect(getIssue(database, first.issue_id!)?.status).toBe("triage");
      const closed = syncTrackerIssueEvent(database, { ...fakeEvent("closed", "2026-07-18T03:00:00.000Z"), provider });
      expect(closed.conflict).toBe(false);
      expect(getIssue(database, first.issue_id!)?.status).toBe("done");
      expect(database.sqlite.query("select action from tracker_sync_events order by id").all()).toEqual([
        { action: "intake_created" }, { action: "status_applied" }, { action: "status_applied" }
      ]);
      expect(database.sqlite.query("select count(*) as count from external_events").get()).toEqual({ count: 1 });
    } finally { database.close(); }
  });
});

function githubEvent(action: "closed" | "reopened", updatedAt: string) {
  return trackerIssueFromPayload("github", {
    action, issue: { id: 99, title: "External title", body: "External body", state: action === "closed" ? "closed" : "open", updated_at: updatedAt, html_url: "https://github.invalid/acme/demo/issues/99" },
    repository: { full_name: "acme/demo" }, sender: { login: "octo" }
  }, "issues", `${action}-${updatedAt}`);
}
function linkedGitHubIssue(database: RunnerDatabase, status: string) {
  const issue = createIssue(database, { project_id: "demo", title: "Local title", description: "Local description", status });
  upsertTrackerIssueLink(database, { provider: "github", external_id: "acme/demo:99", issue_id: issue.id, last_external_updated_at: "2026-07-18T00:00:00.000Z", last_synced_issue_updated_at: issue.updated_at });
  return issue;
}
function fakeEvent(status: string, updatedAt: string) { return { actor: "fake", cursor: { position: "1", scope: "demo" }, description: "Fake tracker intake", event_name: "issue", external_id: "demo:1", external_status: status, external_updated_at: updatedAt, payload: { id: 1, status }, provider: "fake" as const, scope: "demo", title: "Fake tracker issue", url: "https://fake.tracker.invalid/demo/1" }; }
async function fixture(): Promise<RunnerDatabase> { const root = await mkdtemp(join(tmpdir(), "xuanwu-tracker-sync-")); roots.push(root); const database = await openDatabase({ dbPath: join(root, "runner.sqlite"), stateDir: root }); database.sqlite.run("insert into projects (id, name, cwd, created_at, updated_at) values ('demo', 'Demo', ?, '2026-07-18T00:00:00.000Z', '2026-07-18T00:00:00.000Z')", [root]); return database; }
