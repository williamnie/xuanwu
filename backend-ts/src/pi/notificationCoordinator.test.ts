import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { createIssue } from "../db/repositories/issueCreate.ts";
import { type Issue } from "../db/repositories/issues.ts";
import {
  createPiGuardianEvent,
  createPiNotificationPreference,
  listPiNotificationIntents
} from "../db/repositories/pi.ts";
import { coordinateIssueLifecycleNotification } from "./notificationCoordinator.ts";

const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) await rm(root, { recursive: true, force: true });
  }
});

describe("PI notification coordinator preference boundaries", () => {
  test("uses old preference for boundary event and new preference for later event", async () => {
    const db = await fixtureDatabase();
    try {
      const issue = createIssue(db, { project_id: "demo", status: "done", title: "Boundary task" });
      createPiNotificationPreference(db, {
        effective_after_sequence: 0,
        id: "pref-old-quiet",
        mode: "quiet",
        project_id: "demo",
        scope: "project"
      });
      const boundaryEvent = guardianEvent(db, issue, "event-boundary", {
        source: "scheduler",
        sourceSequence: 100
      });
      createPiNotificationPreference(db, {
        effective_after_sequence: boundaryEvent.sequence_id,
        id: "pref-new-normal",
        mode: "normal",
        project_id: "demo",
        scope: "project"
      });
      const laterEvent = guardianEvent(db, issue, "event-later", {
        source: "issue_events",
        sourceSequence: 1
      });

      const oldResult = coordinateIssueLifecycleNotification(db, { event: boundaryEvent, issue });
      const newResult = coordinateIssueLifecycleNotification(db, { event: laterEvent, issue });

      expect(oldResult).toMatchObject({ decision: "suppress" });
      expect(newResult).toMatchObject({ decision: "send_now" });
      expect(listPiNotificationIntents(db, { issueId: issue.id })).toEqual(expect.arrayContaining([
        expect.objectContaining({
          decision: "suppress",
          preference_id: "pref-old-quiet",
          source_event_sequence_id: boundaryEvent.sequence_id
        }),
        expect.objectContaining({
          decision: "send_now",
          preference_id: "pref-new-normal",
          source_event_sequence_id: laterEvent.sequence_id
        })
      ]));
    } finally {
      db.close();
    }
  });
});

async function fixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-pi-notification-coordinator-"));
  tempRoots.push(root);
  const db = await openDatabase({ stateDir: join(root, "state") });
  db.sqlite.run(
    `insert into projects (id, name, cwd, provider, provider_config_json, sort_order, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?)`,
    ["demo", "Demo", join(root, "project"), "codex", "{}", 1,
      "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
  return db;
}

function guardianEvent(
  db: RunnerDatabase,
  issue: Issue,
  id: string,
  input: { source?: string; sourceSequence?: number } = {}
) {
  return createPiGuardianEvent(db, {
    event_type: "issue.status_changed",
    id,
    idempotency_key: `issue.status_changed:demo:${issue.id}:${id}`,
    issue_id: issue.id,
    project_id: "demo",
    source: input.source ?? "issue_events",
    source_event_id: id,
    source_sequence: input.sourceSequence,
    status: "consumed"
  });
}
