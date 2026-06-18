import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { listPiGuardianEvents } from "../db/repositories/pi.ts";
import { ingestPiGuardianEvent } from "./guardianEventIngest.ts";

const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) {
    const path = tempRoots.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

describe("PI Guardian event ingest", () => {
  test("normalizes provider events into the ordered inbox", async () => {
    const db = await openFixtureDatabase();
    try {
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
    } finally {
      db.close();
    }
  });
});

async function openFixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-pi-guardian-ingest-"));
  tempRoots.push(root);
  return openDatabase({ stateDir: join(root, "state") });
}
