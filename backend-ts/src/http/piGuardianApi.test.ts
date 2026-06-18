import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import {
  addPiRunGroupItem,
  createPiGuardianEvent,
  createPiNotificationIntent,
  listPiNotificationPreferences,
  createPiRunGroup,
  updatePiNotificationIntent
} from "../db/repositories/pi.ts";
import { createDefaultRouter } from "./server.ts";

const BASE_URL = "http://127.0.0.1:3008";
const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) {
    const path = tempRoots.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

describe("PI Guardian API", () => {
  test("returns redacted run group detail and notification intent summaries", async () => {
    const database = await openFixtureDatabase();
    try {
      insertIssue(database, 701, "Done A", "done");
      insertIssue(database, 702, "Failed secret issue", "failed");
      insertIssue(database, 703, "Active C", "in_progress");
      createPiRunGroup(database, {
        id: "group-api",
        project_id: "demo",
        expected_issue_count: 3,
        status: "partial",
        user_phrase: "run all CODEX_API_KEY=fixture-secret at /Users/xiaobei/private"
      });
      addPiRunGroupItem(database, {
        run_group_id: "group-api",
        issue_id: 701,
        position: 1,
        enqueue_status: "completed",
        final_issue_status: "done"
      });
      addPiRunGroupItem(database, {
        run_group_id: "group-api",
        issue_id: 702,
        position: 2,
        enqueue_status: "completed",
        final_issue_status: "failed",
        report_reason: "tests failed CODEX_API_KEY=fixture-secret at /Users/xiaobei/private/log.txt"
      });
      addPiRunGroupItem(database, { run_group_id: "group-api", issue_id: 703, position: 3, enqueue_status: "completed" });
      createPiNotificationIntent(database, {
        flush_reason: "partial_deadline",
        flush_sequence: 1,
        id: "digest-1",
        kind: "digest",
        project_id: "demo",
        payload_json: {
          active_count: 1,
          completed_count: 1,
          failed_count: 1,
          issues: [{ bucket: "failed", issue_id: 702, reason: "secret=fixture-secret at /Users/xiaobei/private" }],
          total_count: 3
        },
        run_group_id: "group-api",
        state: "sent",
        summary: "partial with CODEX_API_KEY=fixture-secret",
        target_channel: "feishu"
      });
      updatePiNotificationIntent(database, "digest-1", { sent_at: "2026-06-18T02:00:00Z", sent_outbox_id: 9 });
      createPiNotificationIntent(database, {
        error: "delivery failed CODEX_API_KEY=fixture-secret at /Users/xiaobei/private",
        id: "intent-ready",
        kind: "issue_failed",
        issue_id: 702,
        payload_json: { raw: "do not return fixture-secret" },
        project_id: "demo",
        run_group_id: "group-api",
        state: "ready",
        summary: "failed CODEX_API_KEY=fixture-secret",
        target_channel: "feishu"
      });

      const router = createDefaultRouter({ database });
      const groups = await getJson(router, "/api/pi/guardian/run-groups?project_id=demo&status=partial");
      const detail = await getJson(router, "/api/pi/guardian/run-groups/group-api");
      const intents = await getJson(router, "/api/pi/guardian/notification-intents?run_group_id=group-api&state=ready");
      const detailText = JSON.stringify(detail);

      expect(groups).toMatchObject([{
        id: "group-api",
        expected_issue_count: 3,
        item_buckets: { active: 1, done: 1, failed: 1 },
        last_digest: { flush_reason: "partial_deadline", sent_outbox_id: 9 },
        pending_failed_intent_count: 1
      }]);
      expect(detail).toMatchObject({
        id: "group-api",
        expected_issue_count: 3,
        item_buckets: { active: 1, done: 1, failed: 1 },
        items: expect.arrayContaining([
          expect.objectContaining({ issue_id: 701 }),
          expect.objectContaining({ issue_id: 702 })
        ]),
        last_digest: { counts: { active: 1, completed: 1, failed: 1, total: 3 } },
        pending_failed_intents: expect.arrayContaining([
          expect.objectContaining({ id: "intent-ready", state: "ready" })
        ])
      });
      expect(intents).toMatchObject([{
        id: "intent-ready",
        issue_id: 702,
        run_group_id: "group-api",
        state: "ready"
      }]);
      expect(detailText).not.toContain("payload_json");
      expect(detailText).not.toContain("fixture-secret");
      expect(detailText).not.toContain("/Users/xiaobei/private");
      expect(JSON.stringify(intents)).not.toContain("payload_json");
    } finally {
      database.close();
    }
  });

  test("manually flushes one selected run group digest", async () => {
    const database = await openFixtureDatabase();
    try {
      insertIssue(database, 801, "Still active", "in_progress");
      createPiRunGroup(database, {
        id: "group-manual",
        project_id: "demo",
        expected_issue_count: 1,
        max_interval_minutes: 120
      });
      addPiRunGroupItem(database, {
        run_group_id: "group-manual",
        issue_id: 801,
        position: 1,
        enqueue_status: "completed"
      });

      const router = createDefaultRouter({ database });
      const flushed = await postJson(router, "/api/pi/guardian/digest/flush", {
        now: "2026-06-18T03:00:00Z",
        run_group_id: "group-manual"
      });
      const intents = await getJson(router, "/api/pi/guardian/notification-intents?run_group_id=group-manual&kind=digest");

      expect(flushed).toEqual({ flushed: 1, scanned: 1, skipped: 0 });
      expect(intents).toMatchObject([{
        flush_reason: "manual",
        flush_sequence: 1,
        payload_summary: { counts: { active: 1, total: 1 } },
        state: "ready"
      }]);
    } finally {
      database.close();
    }
  });

  test("writes structured notification preferences only after validator and DB persistence", async () => {
    const database = await openFixtureDatabase();
    try {
      const anchor = createPiGuardianEvent(database, {
        id: "event-before-api-pref",
        event_type: "issue.failed",
        idempotency_key: "issue.failed:demo:901:event-before-api-pref",
        issue_id: 901,
        project_id: "demo",
        source: "issue_events",
        source_event_id: "issue_event:901"
      });
      const router = createDefaultRouter({ database });

      const created = await postJson(router, "/api/pi/guardian/preferences", {
        conversation_id: "conv-api",
        expires_at: "2026-06-18T06:00:00Z",
        mode: "digest",
        now: "2026-06-18T01:00:00Z",
        notify_on: ["needs_user"],
        project_id: "demo",
        scope: "conversation",
        source_message_id: "om_api_pref",
        temporary: true
      });
      const listed = await getJson(router, "/api/pi/guardian/preferences?project_id=demo&conversation_id=conv-api");

      expect(created).toMatchObject({
        confirmation_text: expect.stringContaining("scope=conversation"),
        preference: {
          conversation_id: "conv-api",
          effective_after_sequence: anchor.sequence_id,
          expires_at: "2026-06-18T06:00:00Z",
          mode: "digest",
          project_id: "demo",
          scope: "conversation"
        }
      });
      expect(JSON.stringify(created)).toContain("覆盖关系");
      expect(listed).toMatchObject([{
        confirmation_text: expect.stringContaining("mode=digest"),
        effective_after_sequence: anchor.sequence_id,
        expires_at: "2026-06-18T06:00:00Z",
        notify_on: expect.arrayContaining(["needs_user"]),
        scope: "conversation"
      }]);
      expect(listPiNotificationPreferences(database, { scope: "conversation" })).toHaveLength(1);

      const invalid = await postRaw(router, "/api/pi/guardian/preferences", {
        mode: "quiet",
        scope: "conversation",
        temporary: true,
        ttl_minutes: 999999
      });
      expect(invalid.status).toBe(400);
      expect(listPiNotificationPreferences(database, { scope: "conversation" })).toHaveLength(1);

      database.sqlite.run("drop table pi_notification_preferences");
      const dbFailed = await postRaw(router, "/api/pi/guardian/preferences", {
        mode: "quiet",
        scope: "global",
        temporary: true,
        ttl_minutes: 60
      });
      expect(dbFailed.status).toBe(500);
      expect(await dbFailed.text()).not.toContain("confirmation_text");
    } finally {
      database.close();
    }
  });
});

async function openFixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-pi-guardian-api-"));
  tempRoots.push(root);
  return openDatabase({ stateDir: join(root, "state") });
}

async function getJson(router: ReturnType<typeof createDefaultRouter>, path: string): Promise<unknown> {
  const response = await router.handle(new Request(`${BASE_URL}${path}`));
  expect(response.status).toBe(200);
  return response.json();
}

async function postJson(router: ReturnType<typeof createDefaultRouter>, path: string, body: unknown): Promise<unknown> {
  const response = await postRaw(router, path, body);
  expect(response.status).toBe(200);
  return response.json();
}

async function postRaw(router: ReturnType<typeof createDefaultRouter>, path: string, body: unknown): Promise<Response> {
  return router.handle(new Request(`${BASE_URL}${path}`, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "POST"
  }));
}

function insertIssue(db: RunnerDatabase, id: number, title: string, status: string): void {
  db.sqlite.run("insert or ignore into projects (id, name, cwd, created_at, updated_at) values (?, ?, ?, ?, ?)", [
    "demo", "Demo", `/tmp/demo-${id}`, "2026-06-18T00:00:00Z", "2026-06-18T00:00:00Z"
  ]);
  db.sqlite.run(
    "insert into issues (id, project_id, title, status, created_at, updated_at) values (?, ?, ?, ?, ?, ?)",
    [id, "demo", title, status, "2026-06-18T00:00:00Z", "2026-06-18T00:00:00Z"]
  );
}
