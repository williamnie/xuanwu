import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { createPiNotificationPreference } from "../db/repositories/pi.ts";
import { resolvePiNotificationPreference } from "./notificationPreferenceResolver.ts";

const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) {
    const path = tempRoots.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

describe("PI notification preference resolver", () => {
  test("resolves run group over conversation, project, and global preferences", async () => {
    const db = await openFixtureDatabase();
    try {
      createPreference(db, "pref-global", "global", "normal");
      createPreference(db, "pref-project", "project", "digest", { project_id: "demo" });
      createPreference(db, "pref-conversation", "conversation", "quiet", {
        conversation_id: "conv-1",
        project_id: "demo"
      });
      createPreference(db, "pref-run-group", "run_group", "verbose", {
        conversation_id: "conv-1",
        project_id: "demo",
        run_group_id: "group-1"
      });

      const resolved = resolvePiNotificationPreference(db, context());

      expect(resolved).toMatchObject({
        preferenceID: "pref-run-group",
        reason: "matched_run_group",
        source: "run_group"
      });
      expect(resolved.preference?.mode).toBe("verbose");
    } finally {
      db.close();
    }
  });

  test("resolves conversation temporary over project default", async () => {
    const db = await openFixtureDatabase();
    try {
      createPreference(db, "pref-project-admin-default", "project", "digest", {
        policy_kind: "admin_default",
        project_id: "demo"
      });
      createPreference(db, "pref-conversation-temporary", "conversation", "quiet", {
        conversation_id: "conv-1",
        expires_at: "2026-06-19T00:00:00Z",
        project_id: "demo"
      });

      const resolved = resolvePiNotificationPreference(db, context());

      expect(resolved).toMatchObject({
        preferenceID: "pref-conversation-temporary",
        reason: "matched_conversation",
        source: "conversation"
      });
      expect(resolved.preference?.policy_kind).toBe("user_preference");
    } finally {
      db.close();
    }
  });

  test("resolves project default over global preference", async () => {
    const db = await openFixtureDatabase();
    try {
      createPreference(db, "pref-global", "global", "normal");
      createPreference(db, "pref-project", "project", "digest", { project_id: "demo" });

      const resolved = resolvePiNotificationPreference(db, {
        eventSequence: 10,
        projectID: "demo",
        referenceTime: "2026-06-18T08:00:00Z"
      });

      expect(resolved).toMatchObject({
        preferenceID: "pref-project",
        reason: "matched_project",
        source: "project"
      });
    } finally {
      db.close();
    }
  });

  test("resolves global preference before system default", async () => {
    const db = await openFixtureDatabase();
    try {
      createPreference(db, "pref-global", "global", "digest");

      const resolved = resolvePiNotificationPreference(db, {
        eventSequence: 10,
        referenceTime: "2026-06-18T08:00:00Z"
      });

      expect(resolved).toMatchObject({
        preferenceID: "pref-global",
        reason: "matched_global",
        source: "global"
      });
    } finally {
      db.close();
    }
  });

  test("ignores preferences that are not effective for the event sequence", async () => {
    const db = await openFixtureDatabase();
    try {
      createPreference(db, "pref-future-project", "project", "quiet", {
        effective_after_sequence: 10,
        project_id: "demo"
      });

      const resolved = resolvePiNotificationPreference(db, {
        eventSequence: 10,
        projectID: "demo",
        referenceTime: "2026-06-18T08:00:00Z"
      });

      expect(resolved).toMatchObject({
        preferenceID: "",
        reason: "system_default",
        source: "system_default"
      });
    } finally {
      db.close();
    }
  });

  test("resolves admin enforced preference with override reason", async () => {
    const db = await openFixtureDatabase();
    try {
      createPreference(db, "pref-conversation-temporary", "conversation", "quiet", {
        conversation_id: "conv-1",
        expires_at: "2026-06-19T00:00:00Z",
        project_id: "demo"
      });
      createPreference(db, "pref-project-admin-enforced", "project", "normal", {
        policy_kind: "admin_enforced",
        project_id: "demo"
      });

      const resolved = resolvePiNotificationPreference(db, context());

      expect(resolved).toMatchObject({
        preferenceID: "pref-project-admin-enforced",
        reason: "admin_enforced_override",
        source: "admin_enforced"
      });
      expect(resolved.preference?.mode).toBe("normal");
    } finally {
      db.close();
    }
  });

  test("returns system default when no preference matches", async () => {
    const db = await openFixtureDatabase();
    try {
      const resolved = resolvePiNotificationPreference(db, context());

      expect(resolved).toMatchObject({
        preference: null,
        preferenceID: "",
        reason: "system_default",
        source: "system_default"
      });
      expect(resolved.effective).toMatchObject({
        digest_policy: {},
        mode: "normal",
        notify_on: []
      });
    } finally {
      db.close();
    }
  });

  test("does not match scoped preferences when context lacks that scope id", async () => {
    const db = await openFixtureDatabase();
    try {
      createPreference(db, "pref-other-run-group", "run_group", "verbose", {
        project_id: "demo",
        run_group_id: "group-other"
      });
      createPreference(db, "pref-other-conversation", "conversation", "quiet", {
        conversation_id: "conv-other",
        project_id: "demo"
      });

      const resolved = resolvePiNotificationPreference(db, {
        eventSequence: 10,
        projectID: "demo",
        referenceTime: "2026-06-18T08:00:00Z"
      });

      expect(resolved).toMatchObject({
        preferenceID: "",
        reason: "system_default",
        source: "system_default"
      });
    } finally {
      db.close();
    }
  });
});

function context() {
  return {
    conversationID: "conv-1",
    eventSequence: 10,
    projectID: "demo",
    referenceTime: "2026-06-18T08:00:00Z",
    runGroupID: "group-1"
  };
}

function createPreference(
  db: RunnerDatabase,
  id: string,
  scope: string,
  mode: string,
  input: Record<string, unknown> = {}
): void {
  createPiNotificationPreference(db, {
    effective_after_sequence: 1,
    id,
    mode,
    scope,
    ...input
  });
}

async function openFixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-pi-notification-resolver-"));
  tempRoots.push(root);
  return openDatabase({ stateDir: join(root, "state") });
}
