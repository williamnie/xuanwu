import { describe, expect, test } from "bun:test";
import { nextRunAfter, parseScheduleExpression } from "./cronSchedule.ts";

describe("Cron schedule parser", () => {
  test("parses Chinese one-shot evening schedules with timezone", () => {
    const parsed = parseScheduleExpression("今晚 9 点", {
      base: new Date("2026-06-02T10:00:00Z"),
      timezone: "Asia/Shanghai"
    });

    expect(parsed).toMatchObject({
      mode: "once",
      next_run_at: "2026-06-02T13:00:00.000Z",
      time_of_day: "21:00",
      timezone: "Asia/Shanghai"
    });
  });

  test("moves today one-shot schedules to tomorrow when the time already passed", () => {
    const parsed = parseScheduleExpression("今晚 8 点", {
      base: new Date("2026-06-02T14:00:00Z"),
      timezone: "Asia/Shanghai"
    });

    expect(parsed).toMatchObject({
      mode: "once",
      next_run_at: "2026-06-03T12:00:00.000Z",
      time_of_day: "20:00",
      timezone: "Asia/Shanghai"
    });
  });

  test("parses daily morning schedules", () => {
    const parsed = parseScheduleExpression("每天早上 9 点", {
      base: new Date("2026-06-02T00:30:00Z"),
      timezone: "Asia/Shanghai"
    });

    expect(parsed).toMatchObject({
      mode: "daily",
      next_run_at: "2026-06-02T01:00:00.000Z",
      time_of_day: "09:00"
    });
  });

  test("defaults Chinese schedules to Asia/Shanghai timezone", () => {
    const parsed = parseScheduleExpression("每天早上 9 点", {
      base: new Date("2026-06-02T00:30:00Z")
    });

    expect(parsed).toMatchObject({
      next_run_at: "2026-06-02T01:00:00.000Z",
      timezone: "Asia/Shanghai"
    });
  });

  test("returns a clear error for unsupported natural language schedules", () => {
    expect(() => parseScheduleExpression("下周三晚上 8 点", {
      base: new Date("2026-06-02T00:30:00Z")
    })).toThrow("schedule expression unsupported");
  });

  test("parses weekday after-work schedules as delegated working-hours policy", () => {
    const parsed = parseScheduleExpression("工作日下班后", {
      base: new Date("2026-06-05T09:00:00Z"),
      timezone: "Asia/Shanghai"
    });

    expect(parsed).toMatchObject({
      mode: "daily",
      next_run_at: "2026-06-05T10:30:00.000Z",
      time_of_day: "18:30"
    });
    expect(JSON.parse(parsed.working_hours_json)).toMatchObject({
      after_hours_mode: "delegated",
      weekdays: [1, 2, 3, 4, 5]
    });
  });

  test("computes weekly and monthly next runs from the previous due date", () => {
    expect(nextRunAfter({
      mode: "weekly",
      next_run_at: "2026-06-01T01:00:00.000Z",
      time_of_day: "09:00",
      timezone: "Asia/Shanghai",
      working_hours_json: "{}"
    }, new Date("2026-06-02T00:00:00Z"))).toBe("2026-06-08T01:00:00.000Z");

    expect(nextRunAfter({
      mode: "monthly",
      next_run_at: "2026-01-31T01:00:00.000Z",
      time_of_day: "09:00",
      timezone: "Asia/Shanghai",
      working_hours_json: "{}"
    }, new Date("2026-02-01T00:00:00Z"))).toBe("2026-02-28T01:00:00.000Z");
  });

  test("catches missed weekly and monthly runs by their schedule period", () => {
    expect(nextRunAfter({
      mode: "weekly",
      next_run_at: "2026-01-01T09:00:00.000Z",
      time_of_day: "09:00",
      timezone: "UTC",
      working_hours_json: "{}"
    }, new Date("2026-01-20T00:00:00Z"))).toBe("2026-01-22T09:00:00.000Z");

    expect(nextRunAfter({
      mode: "monthly",
      next_run_at: "2026-01-31T09:00:00.000Z",
      time_of_day: "09:00",
      timezone: "UTC",
      working_hours_json: "{}"
    }, new Date("2026-04-10T00:00:00Z"))).toBe("2026-04-30T09:00:00.000Z");
  });

  test("moves long-missed daily runs to the next future slot", () => {
    expect(nextRunAfter({
      mode: "daily",
      next_run_at: "2026-05-30T18:30:00.000Z",
      time_of_day: "18:30",
      timezone: "UTC",
      working_hours_json: "{}"
    }, new Date("2026-06-02T10:00:00Z"))).toBe("2026-06-02T18:30:00.000Z");
  });
});
