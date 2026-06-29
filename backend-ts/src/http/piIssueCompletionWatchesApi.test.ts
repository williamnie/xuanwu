import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { createIssue } from "../db/repositories/issueCreate.ts";
import { updateIssue } from "../db/repositories/issueUpdate.ts";
import {
  createPiIssueCompletionWatch,
  getPiIssueCompletionWatch
} from "../db/repositories/pi.ts";
import { evaluatePiIssueCompletionWatchesForIssue } from "../pi/issueCompletionWatchEvaluator.ts";
import { queueReadyFeishuCompletionWatchNotifications } from "../integrations/feishuCompletionWatchNotifications.ts";
import { createDefaultRouter } from "./server.ts";

const BASE_URL = "http://127.0.0.1:3008";
const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) await rm(tempRoots.pop() ?? "", { recursive: true, force: true });
});

describe("PI issue completion watch API", () => {
  test("lists active watches, reads detail with items/outbox status, and cancels a watch", async () => {
    const db = await fixtureDatabase();
    try {
      const done = createIssue(db, { project_id: "demo", status: "todo", title: "Done task" });
      const failed = createIssue(db, { project_id: "demo", status: "todo", title: "Failed task" });
      const active = createIssue(db, { project_id: "demo", status: "todo", title: "Still active" });
      const watch = createWatch(db, [done.id, failed.id], "watch-api-summary");
      const cancellable = createWatch(db, [active.id], "watch-api-cancel");
      satisfyIssue(db, done.id, "done");
      satisfyIssue(db, failed.id, "failed");
      queueReadyFeishuCompletionWatchNotifications(db);
      const router = createDefaultRouter({ database: db });

      const activeList = await getJson(router, "/api/pi/issue-completion-watches?status=active&project_id=demo");
      const detail = await getJson(router, `/api/pi/issue-completion-watches/${watch.id}`);
      const cancelled = await postJson(router, `/api/pi/issue-completion-watches/${cancellable.id}/cancel`, {
        reason: "api smoke cleanup"
      });

      expect(activeList).toMatchObject({ count: 1, items: [{ id: cancellable.id, status: "active" }] });
      expect(detail).toMatchObject({
        id: watch.id,
        items: expect.arrayContaining([
          expect.objectContaining({ issue_id: done.id, last_status: "done" }),
          expect.objectContaining({ issue_id: failed.id, last_status: "failed" })
        ]),
        notifications: [expect.objectContaining({
          outbox: expect.objectContaining({ status: "pending" }),
          state: "sent"
        })],
        status: "satisfied",
        target: { chat_id: "oc_watch", message_id: "om_watch" }
      });
      expect(cancelled).toMatchObject({ id: cancellable.id, status: "cancelled" });
      expect(getPiIssueCompletionWatch(db, cancellable.id)).toMatchObject({ error: "api smoke cleanup" });
    } finally {
      db.close();
    }
  });
});

async function fixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-watch-api-"));
  tempRoots.push(root);
  const db = await openDatabase({ stateDir: join(root, "state") });
  insertProject(db, root);
  return db;
}

function createWatch(db: RunnerDatabase, issueIDs: number[], sourceEventID: string) {
  return createPiIssueCompletionWatch(db, {
    issue_ids: issueIDs,
    origin_conversation_id: "feishu-chat-oc_watch-20260629",
    project_id: "demo",
    source_event_id: sourceEventID,
    target_channel: "feishu",
    target_chat_id: "oc_watch",
    target_message_id: "om_watch",
    target_thread_id: "omt_watch"
  });
}

function satisfyIssue(db: RunnerDatabase, issueID: number, status: string): void {
  updateIssue(db, issueID, { status });
  evaluatePiIssueCompletionWatchesForIssue(db, { issueID, projectID: "demo", status });
}

function insertProject(db: RunnerDatabase, root: string): void {
  db.sqlite.run(
    `insert into projects (id, name, cwd, provider, provider_config_json, sort_order, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?)`,
    ["demo", "Demo", join(root, "project"), "codex", "{}", 1, "2026-06-29T00:00:00Z", "2026-06-29T00:00:00Z"]
  );
}

async function getJson(router: ReturnType<typeof createDefaultRouter>, path: string): Promise<Record<string, unknown>> {
  const response = await router.handle(new Request(`${BASE_URL}${path}`));
  expect(response.status).toBe(200);
  return await response.json() as Record<string, unknown>;
}

async function postJson(
  router: ReturnType<typeof createDefaultRouter>,
  path: string,
  body: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const response = await router.handle(new Request(`${BASE_URL}${path}`, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "POST"
  }));
  expect(response.status).toBe(200);
  return await response.json() as Record<string, unknown>;
}
