import { describe, expect, test } from "bun:test";
import { type RunnerDatabase } from "../../db/database.ts";
import { createPiNotificationPreference } from "../../db/repositories/pi.ts";
import { resolvePiNotificationPreference } from "./notificationPreferenceResolver.ts";
import { useTestDatabase } from "../../testing/harness.ts";

const openFixtureDatabase = useTestDatabase();

describe("PI notification preference resolver", () => {
  test("resolves run group over conversation, project, and global preferences", async () => {
    const db = await openFixtureDatabase();
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
  });

  test("resolves conversation temporary over project default", async () => {
    const db = await openFixtureDatabase();
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
  });

  test("resolves project default over global preference", async () => {
    const db = await openFixtureDatabase();
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
  });

  test("resolves global preference before system default", async () => {
    const db = await openFixtureDatabase();
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
  });

  test("ignores preferences that are not effective for the event sequence", async () => {
    const db = await openFixtureDatabase();
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
  });

  test("uses superseded old preference for events at the new preference boundary", async () => {
    const db = await openFixtureDatabase();
    createPreference(db, "pref-project-old", "project", "quiet", {
      effective_after_sequence: 0,
      project_id: "demo"
    });
    createPreference(db, "pref-project-new", "project", "normal", {
      effective_after_sequence: 10,
      project_id: "demo"
    });

    const oldEventPreference = resolvePiNotificationPreference(db, {
      eventSequence: 10,
      projectID: "demo",
      referenceTime: "2026-06-18T08:00:00Z"
    });
    const newEventPreference = resolvePiNotificationPreference(db, {
      eventSequence: 11,
      projectID: "demo",
      referenceTime: "2026-06-18T08:00:00Z"
    });

    expect(oldEventPreference).toMatchObject({
      preferenceID: "pref-project-old",
      reason: "matched_project",
      source: "project"
    });
    expect(newEventPreference).toMatchObject({
      preferenceID: "pref-project-new",
      reason: "matched_project",
      source: "project"
    });
  });

  test("resolves admin enforced preference with override reason", async () => {
    const db = await openFixtureDatabase();
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
  });

  test("returns system default when no preference matches", async () => {
    const db = await openFixtureDatabase();
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
  });

  test("does not match scoped preferences when context lacks that scope id", async () => {
    const db = await openFixtureDatabase();
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
