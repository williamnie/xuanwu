import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../../database.ts";
import {
  createPiGuardianEvent,
  createPiNotificationPreference,
  disablePiNotificationPreference,
  expirePiNotificationPreferences,
  getPiNotificationPreference,
  listActivePiNotificationPreferences,
  listPiNotificationPreferences
} from "../pi.ts";

const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) {
    const path = tempRoots.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

describe("PI notification preference repository", () => {
  test("lists active preferences while distinguishing expired, superseded, and disabled rows", async () => {
    const db = await openFixtureDatabase();
    try {
      const anchor = createPiGuardianEvent(db, {
        id: "event-before-pref",
        event_type: "issue.started",
        idempotency_key: "issue.started:demo:101:event-before-pref",
        project_id: "demo",
        source: "issue_events",
        source_event_id: "issue_event:101"
      });
      const superseded = createPiNotificationPreference(db, {
        id: "pref-project-old",
        digest_policy_json: { interval_minutes: 120 },
        effective_after_sequence: anchor.sequence_id,
        expires_at: "2026-06-19T00:00:00Z",
        mode: "digest",
        notify_on_json: ["needs_user"],
        project_id: "demo",
        scope: "project"
      });
      const active = createPiNotificationPreference(db, {
        id: "pref-project-current",
        confirmation_text: "已切到项目安静模式",
        effective_after_sequence: anchor.sequence_id,
        expires_at: "2026-06-19T00:00:00Z",
        mode: "quiet",
        notify_on_json: ["needs_user", "budget_exhausted"],
        project_id: "demo",
        scope: "project"
      });
      createPiNotificationPreference(db, {
        id: "pref-conversation-expired",
        conversation_id: "conv-expired",
        effective_after_sequence: 0,
        expires_at: "2026-06-18T07:00:00Z",
        mode: "digest",
        project_id: "demo",
        scope: "conversation"
      });
      createPiNotificationPreference(db, {
        id: "pref-run-disabled",
        effective_after_sequence: 0,
        mode: "verbose",
        project_id: "demo",
        run_group_id: "group-disabled",
        scope: "run_group"
      });
      const expiredCount = expirePiNotificationPreferences(db, "2026-06-18T08:00:00Z");
      const disabled = disablePiNotificationPreference(db, "pref-run-disabled");

      expect(active.version).toBe(superseded.version + 1);
      expect(JSON.parse(active.notify_on_json)).toEqual(["needs_user", "budget_exhausted"]);
      expect(JSON.parse(superseded.digest_policy_json)).toEqual({ interval_minutes: 120 });
      expect(listActivePiNotificationPreferences(db, {
        eventSequence: anchor.sequence_id,
        projectId: "demo",
        referenceTime: "2026-06-18T08:00:00Z"
      })).toEqual([]);
      expect(listActivePiNotificationPreferences(db, {
        eventSequence: anchor.sequence_id + 1,
        projectId: "demo",
        referenceTime: "2026-06-18T08:00:00Z"
      }).map((preference) => preference.id)).toEqual(["pref-project-current"]);
      expect(expiredCount).toBe(1);
      expect(getPiNotificationPreference(db, "pref-project-old")).toMatchObject({ status: "superseded" });
      expect(getPiNotificationPreference(db, "pref-conversation-expired")).toMatchObject({ status: "expired" });
      expect(disabled).toMatchObject({ status: "disabled" });
      expect(listPiNotificationPreferences(db, { status: "superseded" }).map((preference) => preference.id)).toEqual(["pref-project-old"]);
      expect(listPiNotificationPreferences(db, { status: "expired" }).map((preference) => preference.id)).toEqual(["pref-conversation-expired"]);
      expect(listPiNotificationPreferences(db, { status: "disabled" }).map((preference) => preference.id)).toEqual(["pref-run-disabled"]);
    } finally {
      db.close();
    }
  });
});

async function openFixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "xuanwu-pi-notification-preferences-"));
  tempRoots.push(root);
  return openDatabase({ stateDir: join(root, "state") });
}
