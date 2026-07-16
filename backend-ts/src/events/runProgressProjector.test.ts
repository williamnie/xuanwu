import { describe, expect, test } from "bun:test";
import { normalizedRunEvent, providerRunCost } from "../providers/runEvents.ts";
import {
  projectRunAttemptProgress,
  type RunProgressSourceEvent
} from "./runProgressProjector.ts";

describe("Run progress projector", () => {
  test("replays out-of-order fixtures deterministically and compacts duplicate events", () => {
    const events = [
      fixture(8, "2026-01-01T00:00:08.000Z", "completed", "succeeded", "turn/completed", "done"),
      fixture(3, "2026-01-01T00:00:03.000Z", "progress", "running", "item/completed", "tool completed"),
      fixture(1, "2026-01-01T00:00:01.000Z", "started", "running", "turn/started", "started"),
      fixture(6, "2026-01-01T00:00:06.000Z", "approval_resolved", "running", "approval/resolved", "approved"),
      fixture(4, "2026-01-01T00:00:04.000Z", "approval_requested", "waiting_approval", "approval/requested", "approval"),
      fixture(2, "2026-01-01T00:00:02.000Z", "progress", "running", "item/started", "tool started"),
      fixture(5, "2026-01-01T00:00:05.000Z", "progress", "running", "item/output", "waiting output"),
      fixture(7, "2026-01-01T00:00:07.000Z", "approval_resolved", "running", "approval/resolved", "approved"),
      fixture(9, "2026-01-01T00:00:09.000Z", "progress", "running", "item/late", "late progress")
    ];

    const projected = projectRunAttemptProgress({ events, initialPhase: "queued" });
    const replayed = projectRunAttemptProgress({ events: [...events].reverse(), initialPhase: "queued" });

    expect(replayed).toEqual(projected);
    expect(projected).toMatchObject({
      current_phase: "succeeded",
      duplicate_event_count: 1,
      ignored_event_count: 1,
      latest: { kind: "completed", phase: "succeeded", source_event_id: 8 },
      source_event_count: 9,
      timeline: [
        { event_count: 1, phase: "starting" },
        { event_count: 2, phase: "running" },
        { event_count: 2, phase: "waiting_approval" },
        { event_count: 1, phase: "running" },
        { event_count: 1, phase: "succeeded" }
      ],
      unique_event_count: 8
    });
    expect(projected.phase_summary).toEqual(expect.arrayContaining([
      expect.objectContaining({ event_count: 3, phase: "running" }),
      expect.objectContaining({ event_count: 2, phase: "waiting_approval" }),
      expect.objectContaining({ event_count: 1, phase: "succeeded" })
    ]));
  });

  test("never lets late progress move a terminal projection backwards", () => {
    const projected = projectRunAttemptProgress({
      events: [
        fixture(1, "2026-01-01T00:00:01.000Z", "progress", "running", "item/started", "running"),
        fixture(2, "2026-01-01T00:00:02.000Z", "error", "failed", "turn/completed", "failed"),
        fixture(3, "2026-01-01T00:00:03.000Z", "progress", "running", "item/output", "late")
      ],
      initialPhase: "running"
    });

    expect(projected.current_phase).toBe("failed");
    expect(projected.latest).toMatchObject({ phase: "failed", source_event_id: 2 });
    expect(projected.ignored_event_count).toBe(1);
  });

  test("keeps distinct provider usage snapshots as progress", () => {
    const first = fixture(1, "2026-01-01T00:00:01.000Z", "progress", "running", "usage", "usage");
    const second = fixture(2, "2026-01-01T00:00:02.000Z", "progress", "running", "usage", "usage");
    first.event.cost = providerRunCost({ sourceRef: "usage:1", usage: { total_tokens: 10 } });
    second.event.cost = providerRunCost({ sourceRef: "usage:2", usage: { total_tokens: 20 } });

    const projected = projectRunAttemptProgress({ events: [first, second], initialPhase: "running" });

    expect(projected.duplicate_event_count).toBe(0);
    expect(projected.latest?.source_event_id).toBe(2);
    expect(projected.timeline[0]?.event_count).toBe(2);
  });

  test("projects a large fixture in one bounded compact timeline", () => {
    const events = Array.from({ length: 20_000 }, (_, index) => fixture(
      index + 1,
      new Date(Date.UTC(2026, 0, 1, 0, 0, 0, index)).toISOString(),
      "progress",
      "running",
      "item/output",
      `progress ${index}`,
      { sequence: index }
    ));

    const startedAt = performance.now();
    const projected = projectRunAttemptProgress({ events, initialPhase: "queued" });
    const elapsedMs = performance.now() - startedAt;

    expect(projected.source_event_count).toBe(20_000);
    expect(projected.timeline).toHaveLength(1);
    expect(projected.timeline[0]?.event_count).toBe(20_000);
    expect(projected.phase_summary).toMatchObject([{ event_count: 20_000, phase: "running" }]);
    expect(elapsedMs).toBeLessThan(1_500);
  });
});

function fixture(
  id: number,
  occurredAt: string,
  kind: Parameters<typeof normalizedRunEvent>[0]["kind"],
  outcome: Parameters<typeof normalizedRunEvent>[0]["outcome"],
  method: string,
  summary: string,
  metadata: Record<string, string | number> = {}
): RunProgressSourceEvent {
  return {
    attempt_id: "xw:run:issue_runs:fixture~attempt:1",
    attempt_sequence: 1,
    event: normalizedRunEvent({
      kind,
      metadata,
      method,
      outcome,
      provider: "codex",
      session: { provider: "codex", sessionId: "thread-1", turnId: "turn-1" }
    }),
    occurred_at: occurredAt,
    source_event_id: id,
    summary
  };
}
