import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../../database.ts";
import { createPiGuardianEvent, listPiGuardianEvents } from "./guardianEvents.ts";

const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) {
    const path = tempRoots.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

describe("PI Guardian event inbox", () => {
  test("dedupes upstream ids and treats source sequences as source local", async () => {
    const db = await openFixtureDatabase();
    try {
      const upstream = event(db, { id: "upstream-event-1", source_event_id: "provider-event-1" });
      const upstreamDuplicate = event(db, { id: "upstream-event-duplicate", source_event_id: "provider-event-1" });
      const sourceAFirst = event(db, { id: "source-a-7", source_sequence: 7 });
      const sourceADuplicate = event(db, { id: "source-a-7-duplicate", source_sequence: 7 });
      const sourceANext = event(db, { id: "source-a-8", source_sequence: 8 });
      const sourceBMatchingSequence = event(db, {
        id: "source-b-7",
        source: "provider-b",
        source_sequence: 7
      });

      expect(upstreamDuplicate.id).toBe(upstream.id);
      expect(sourceADuplicate.id).toBe(sourceAFirst.id);
      expect(sourceANext.id).toBe("source-a-8");
      expect(sourceBMatchingSequence.id).toBe("source-b-7");
      expect(sequenceIDs(upstream, sourceAFirst, sourceANext, sourceBMatchingSequence))
        .toEqual([0, 1, 2, 3].map((offset) => upstream.sequence_id + offset));
      expect(listPiGuardianEvents(db, { projectId: "demo" }).map((event) => event.id)).toEqual([
        "upstream-event-1",
        "source-a-7",
        "source-a-8",
        "source-b-7"
      ]);
    } finally {
      db.close();
    }
  });

  test("uses a time bucket for no-upstream provider failures", async () => {
    const db = await openFixtureDatabase();
    try {
      const first = createPiGuardianEvent(db, {
        id: "provider-failure-1",
        source: "provider",
        event_type: "provider.failure",
        project_id: "demo",
        issue_id: 301,
        created_at: "2026-06-18T00:00:10Z",
        normalized_payload_json: { diagnosis_code: "stream_disconnect", message: "same failure" }
      });
      const sameBucketDuplicate = createPiGuardianEvent(db, {
        id: "provider-failure-same-minute",
        source: "provider",
        event_type: "provider.failure",
        project_id: "demo",
        issue_id: 301,
        created_at: "2026-06-18T00:00:40Z",
        normalized_payload_json: { diagnosis_code: "stream_disconnect", message: "same failure" }
      });
      const nextBucketRepeat = createPiGuardianEvent(db, {
        id: "provider-failure-next-minute",
        source: "provider",
        event_type: "provider.failure",
        project_id: "demo",
        issue_id: 301,
        created_at: "2026-06-18T00:01:00Z",
        normalized_payload_json: { diagnosis_code: "stream_disconnect", message: "same failure" }
      });

      expect(sameBucketDuplicate.id).toBe(first.id);
      expect(nextBucketRepeat.id).toBe("provider-failure-next-minute");
      expect(nextBucketRepeat.sequence_id).toBeGreaterThan(first.sequence_id);
      expect(listPiGuardianEvents(db, { projectId: "demo" }).map((event) => event.id)).toEqual([
        "provider-failure-1",
        "provider-failure-next-minute"
      ]);
    } finally {
      db.close();
    }
  });

});

async function openFixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-pi-guardian-events-"));
  tempRoots.push(root);
  return openDatabase({ stateDir: join(root, "state") });
}

function event(
  db: RunnerDatabase,
  input: Parameters<typeof createPiGuardianEvent>[1]
): ReturnType<typeof createPiGuardianEvent> {
  return createPiGuardianEvent(db, {
    event_type: "provider.failure",
    issue_id: 201,
    normalized_payload_json: { code: "disconnect" },
    project_id: "demo",
    source: "provider-a",
    ...input
  });
}

function sequenceIDs(...events: ReturnType<typeof createPiGuardianEvent>[]): number[] {
  return events.map((event) => event.sequence_id);
}
