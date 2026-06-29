import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { createIssue } from "../db/repositories/issueCreate.ts";
import { getIssue } from "../db/repositories/issues.ts";
import {
  createPiIssueCompletionWatch,
  getPiIssueCompletionWatch,
  listPiNotificationIntents
} from "../db/repositories/pi.ts";
import { updateIssue } from "../db/repositories/issueUpdate.ts";
import { EventBus } from "../events/bus.ts";
import { attachFeishuNotificationObservers } from "../integrations/feishuNotifications.ts";
import {
  attachPiIssueCompletionWatchObserver,
  evaluatePiIssueCompletionWatchesForIssue,
  sweepActivePiIssueCompletionWatches
} from "./issueCompletionWatchEvaluator.ts";

const WATCH_KIND = "issue_completion_watch_satisfied";
const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) await rm(root, { recursive: true, force: true });
  }
});

describe("PI issue completion watch evaluator", () => {
  test("keeps all-terminal watches active until every issue leaves triage todo and in_progress", async () => {
    const db = await fixtureDatabase();
    try {
      const first = createIssue(db, { project_id: "demo", title: "A", status: "todo" });
      const second = createIssue(db, { project_id: "demo", title: "B", status: "in_progress" });
      const watch = createWatch(db, [first.id, second.id], "watch-all-terminal");

      updateIssue(db, first.id, { status: "done" });
      const partial = evaluatePiIssueCompletionWatchesForIssue(db, {
        eventID: "event-first-done",
        eventType: "issue.status_changed",
        issueID: first.id,
        projectID: "demo",
        status: "done"
      });

      expect(partial.satisfied).toBe(0);
      expect(getPiIssueCompletionWatch(db, watch.id)?.status).toBe("active");
      expect(listWatchIntents(db)).toHaveLength(0);

      updateIssue(db, second.id, { status: "pending_verification" });
      const satisfied = evaluatePiIssueCompletionWatchesForIssue(db, {
        eventID: "event-second-pending-verification",
        eventType: "issue.status_changed",
        issueID: second.id,
        projectID: "demo",
        status: "pending_verification"
      });
      const intent = listWatchIntents(db)[0];

      expect(satisfied.satisfied).toBe(1);
      expect(getPiIssueCompletionWatch(db, watch.id)?.status).toBe("satisfied");
      expect(intent).toMatchObject({
        kind: WATCH_KIND,
        state: "ready",
        target_chat_id: "oc_watch"
      });
      expect(JSON.parse(intent?.payload_json ?? "{}")).toMatchObject({
        next_step: expect.any(String),
        stats: { pending_verification: 1, total: 2 },
        watch_id: watch.id
      });
    } finally {
      db.close();
    }
  });

  test("uses the watch target for failed and cancelled issues without missing Feishu links", async () => {
    const db = await fixtureDatabase();
    const bus = new EventBus();
    const detachFeishu = attachFeishuNotificationObservers({ bus, database: db });
    const detachWatch = attachPiIssueCompletionWatchObserver({ bus, database: db });
    try {
      const first = createIssue(db, { project_id: "demo", title: "Regression #542", status: "todo" });
      const second = createIssue(db, { project_id: "demo", title: "Regression #543", status: "todo" });
      const watch = createWatch(db, [first.id, second.id], "watch-542-543");

      publishStatus(db, bus, first.id, "done");
      publishStatus(db, bus, second.id, "failed");
      publishStatus(db, bus, second.id, "failed");

      const intents = listPiNotificationIntents(db);
      const watchIntents = intents.filter((intent) => intent.kind === WATCH_KIND);
      const payload = JSON.parse(watchIntents[0]?.payload_json ?? "{}");

      expect(getPiIssueCompletionWatch(db, watch.id)?.status).toBe("satisfied");
      expect(watchIntents).toHaveLength(1);
      expect(watchIntents[0]).toMatchObject({
        decision: "send_now",
        error: "",
        state: "ready",
        target_chat_id: "oc_watch"
      });
      expect(payload).toMatchObject({
        issues: expect.arrayContaining([
          expect.objectContaining({ id: first.id, status: "done" }),
          expect.objectContaining({ id: second.id, status: "failed" })
        ]),
        stats: { done: 1, failed: 1, total: 2 },
        watch_id: watch.id
      });
      expect(intents.map((intent) => intent.error)).not.toContain("missing_feishu_link");
    } finally {
      detachWatch();
      detachFeishu();
      db.close();
    }
  });

  test("dedupes repeated terminal status events for a single issue watch", async () => {
    const db = await fixtureDatabase();
    try {
      const issue = createIssue(db, { project_id: "demo", title: "Single", status: "todo" });
      const watch = createWatch(db, [issue.id], "watch-single");

      updateIssue(db, issue.id, { status: "cancelled" });
      evaluatePiIssueCompletionWatchesForIssue(db, { issueID: issue.id, status: "cancelled" });
      evaluatePiIssueCompletionWatchesForIssue(db, { issueID: issue.id, status: "cancelled" });

      expect(getPiIssueCompletionWatch(db, watch.id)?.status).toBe("satisfied");
      expect(listWatchIntents(db)).toHaveLength(1);
      expect(JSON.parse(listWatchIntents(db)[0]?.payload_json ?? "{}")).toMatchObject({
        stats: { cancelled: 1, total: 1 }
      });
    } finally {
      db.close();
    }
  });

  test("sweeps active watches after restart and repairs missed status changes", async () => {
    const db = await fixtureDatabase();
    try {
      const first = createIssue(db, { project_id: "demo", title: "Restart A", status: "todo" });
      const second = createIssue(db, { project_id: "demo", title: "Restart B", status: "todo" });
      const watch = createWatch(db, [first.id, second.id], "watch-restart");

      updateIssue(db, first.id, { status: "done" });
      updateIssue(db, second.id, { status: "failed" });

      const result = sweepActivePiIssueCompletionWatches(db);

      expect(result).toMatchObject({ satisfied: 1, watches: 1 });
      expect(getPiIssueCompletionWatch(db, watch.id)?.status).toBe("satisfied");
      expect(listWatchIntents(db)).toHaveLength(1);
      expect(getPiIssueCompletionWatch(db, watch.id)?.items).toEqual(expect.arrayContaining([
        expect.objectContaining({ issue_id: first.id, last_status: "done" }),
        expect.objectContaining({ issue_id: second.id, last_status: "failed" })
      ]));
    } finally {
      db.close();
    }
  });
});

async function fixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-issue-watch-evaluator-"));
  tempRoots.push(root);
  const db = await openDatabase({ stateDir: join(root, "state") });
  db.sqlite.run(
    `insert into projects (id, name, cwd, provider, provider_config_json, sort_order, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?)`,
    ["demo", "Demo", join(root, "project"), "codex", '{"capabilities":["issue_execution"]}', 1,
      "2026-06-29T00:00:00Z", "2026-06-29T00:00:00Z"]
  );
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
    target_message_id: "om_watch"
  });
}

function listWatchIntents(db: RunnerDatabase) {
  return listPiNotificationIntents(db, { kind: WATCH_KIND });
}

function publishStatus(db: RunnerDatabase, bus: EventBus, issueID: number, status: string): void {
  updateIssue(db, issueID, { status });
  const issue = getIssue(db, issueID);
  bus.publish({
    issueId: issueID,
    payload: JSON.stringify({ status }),
    projectId: issue?.project_id,
    type: "issue.status_changed"
  });
}
