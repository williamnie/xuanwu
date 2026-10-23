import { describe, expect, test } from "bun:test";
import { createPiGuardianEvent, listPiNotificationPreferences } from "../../db/repositories/pi.ts";
import { writePiNotificationPreference } from "./notificationPreferenceService.ts";
import { useTestDatabase } from "../../testing/harness.ts";

const openFixtureDatabase = useTestDatabase();

describe("PI notification preference service", () => {
  test("writes a temporary quiet preference with TTL, effective sequence, and deterministic confirmation", async () => {
    const db = await openFixtureDatabase();
    const anchor = createPiGuardianEvent(db, {
      id: "event-before-preference",
      event_type: "issue.done",
      idempotency_key: "issue.done:demo:701:event-before-preference",
      issue_id: 701,
      project_id: "demo",
      source: "issue_events",
      source_event_id: "issue_event:701"
    });

    const result = writePiNotificationPreference(db, {
      conversation_id: "conv-1",
      mode: "quiet",
      now: "2026-06-18T01:00:00Z",
      notify_on: ["needs_user", "budget_exhausted"],
      project_id: "demo",
      scope: "conversation",
      source_event_id: "external-event-1",
      source_event_sequence_id: 88,
      source_message_id: "om_pref_1",
      temporary: true,
      ttl_minutes: 120
    });

    expect(result.preference).toMatchObject({
      conversation_id: "conv-1",
      effective_after_sequence: anchor.sequence_id,
      expires_at: "2026-06-18T03:00:00Z",
      mode: "quiet",
      project_id: "demo",
      scope: "conversation",
      source_event_sequence_id: 88,
      source_message_id: "om_pref_1"
    });
    expect(JSON.parse(result.preference.notify_on_json)).toEqual(["needs_user", "budget_exhausted"]);
    expect(result.confirmation_text).toContain("scope=conversation");
    expect(result.confirmation_text).toContain("mode=quiet");
    expect(result.confirmation_text).toContain("notify_on=needs_user,budget_exhausted");
    expect(result.confirmation_text).toContain("expires_at=2026-06-18T03:00:00Z");
    expect(result.confirmation_text).toContain("覆盖关系");
    expect(result.preference.confirmation_text).toBe(result.confirmation_text);
  });

  test("uses a bounded default TTL for temporary digest when no expiry is provided", async () => {
    const db = await openFixtureDatabase();
    const result = writePiNotificationPreference(db, {
      conversation_id: "conv-1",
      mode: "digest",
      now: "2026-06-18T01:00:00Z",
      notify_on: ["urgent"],
      scope: "conversation",
      temporary: true
    });

    expect(result.preference.expires_at).toBe("2026-06-18T09:00:00Z");
    expect(result.confirmation_text).toContain("ttl=8h(default)");
  });

  test("rejects invalid candidates before writing a preference row", async () => {
    const db = await openFixtureDatabase();
    expect(() => writePiNotificationPreference(db, {
      mode: "silent",
      scope: "conversation",
      temporary: true,
      ttl_minutes: 60
    })).toThrow("mode must be one of");
    expect(() => writePiNotificationPreference(db, {
      digest_policy: "{invalid",
      expires_at: "2026-06-18T03:00:00Z",
      mode: "digest",
      now: "2026-06-18T01:00:00Z",
      scope: "global"
    })).toThrow("digest_policy must be valid JSON");
    expect(listPiNotificationPreferences(db)).toEqual([]);
  });
});
