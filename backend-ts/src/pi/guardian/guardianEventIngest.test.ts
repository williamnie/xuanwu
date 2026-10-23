import { describe, expect, test } from "bun:test";
import { listPiGuardianEvents } from "../../db/repositories/pi.ts";
import { ingestPiGuardianEvent } from "./guardianEventIngest.ts";
import { useTestDatabase } from "../../testing/harness.ts";

const openFixtureDatabase = useTestDatabase();

describe("PI Guardian event ingest", () => {
  test("normalizes provider events into the ordered inbox", async () => {
    const db = await openFixtureDatabase();
    const first = ingestPiGuardianEvent(db, {
      eventType: "provider.failure",
      issueID: 401,
      normalizedPayload: {
        diagnosis_code: "stream_disconnect",
        message: "Authorization: Bearer secret-token"
      },
      projectID: "demo",
      source: "provider",
      sourceSequence: 10
    });
    const duplicate = ingestPiGuardianEvent(db, {
      eventType: "provider.failure",
      issueID: 401,
      normalizedPayload: { diagnosis_code: "stream_disconnect", message: "changed" },
      projectID: "demo",
      source: "provider",
      sourceSequence: 10
    });

    expect(duplicate.id).toBe(first.id);
    expect(first.sequence_id).toBeGreaterThan(0);
    expect(first.idempotency_key).toBe("provider.failure:demo:401:provider:10");
    expect(first.normalized_payload_json).not.toContain("secret-token");
    expect(listPiGuardianEvents(db, { projectId: "demo" }).map((event) => event.id)).toEqual([first.id]);
  });
});
