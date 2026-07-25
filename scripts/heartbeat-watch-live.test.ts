import { describe, expect, test } from "bun:test";
import {
  actionSideEffectWatermark,
  countWatermark,
  freshWithin,
  missedTickCount,
  sameWatermark
} from "./heartbeat-watch-live.ts";

describe("Issue 780 Heartbeat/Watch live helpers", () => {
  test("counts missed real-clock slots without inventing a replay", () => {
    expect(missedTickCount(
      "2026-07-25T15:00:00.000Z",
      "2026-07-25T15:00:03.600Z",
      1200
    )).toBe(2);
    expect(missedTickCount(
      "2026-07-25T15:00:00.000Z",
      "2026-07-25T15:00:01.200Z",
      1200
    )).toBe(0);
  });

  test("evaluates watchdog freshness with an explicit threshold", () => {
    expect(freshWithin(
      "2026-07-25T15:00:01.000Z",
      "2026-07-25T15:00:02.500Z",
      2400
    )).toBe(true);
    expect(freshWithin(
      "2026-07-25T15:00:01.000Z",
      "2026-07-25T15:00:04.000Z",
      2400
    )).toBe(false);
  });

  test("compares only decisive no-op and downstream side-effect watermarks", () => {
    const state = {
      automation_run_count: 0,
      issue_count: 1,
      issue_run_count: 0,
      notification_intent_count: 1,
      notification_outbox_count: 0,
      watch: { status: "satisfied" },
      watch_terminal_event_count: 1
    };
    expect(countWatermark(state)).toEqual({
      automation_run_count: 0,
      issue_count: 1,
      issue_run_count: 0,
      notification_intent_count: 1
    });
    expect(actionSideEffectWatermark(state)).toEqual({
      notification_intent_count: 1,
      notification_outbox_count: 0,
      watch_status: "satisfied",
      watch_terminal_event_count: 1
    });
    expect(sameWatermark(actionSideEffectWatermark(state), actionSideEffectWatermark({ ...state }))).toBe(true);
  });
});
