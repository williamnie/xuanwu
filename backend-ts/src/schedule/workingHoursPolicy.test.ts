import { describe, expect, test } from "bun:test";
import { quietHoursResumeAt, scheduleRunMode } from "./cronSchedule.ts";

describe("Working hours schedule policy", () => {
  test("returns attended during local working hours and delegated after hours", () => {
    const task = {
      mode: "daily",
      next_run_at: "2026-06-02T10:30:00.000Z",
      time_of_day: "18:30",
      timezone: "Asia/Shanghai",
      working_hours_json: JSON.stringify({
        end: "18:00",
        start: "09:00",
        weekdays: [1, 2, 3, 4, 5]
      })
    };

    expect(scheduleRunMode(task, new Date("2026-06-02T02:00:00Z"))).toBe("attended");
    expect(scheduleRunMode(task, new Date("2026-06-02T11:00:00Z"))).toBe("delegated");
  });

  test("uses timezone when deciding working hours", () => {
    const task = {
      mode: "daily",
      next_run_at: "2026-06-02T22:00:00.000Z",
      time_of_day: "18:00",
      timezone: "America/New_York",
      working_hours_json: JSON.stringify({
        end: "17:00",
        start: "09:00",
        weekdays: [1, 2, 3, 4, 5]
      })
    };

    expect(scheduleRunMode(task, new Date("2026-06-02T14:00:00Z"))).toBe("attended");
    expect(scheduleRunMode(task, new Date("2026-06-02T22:00:00Z"))).toBe("delegated");
  });

  test("resumes after project-style daily quiet hours", () => {
    const resumeAt = quietHoursResumeAt({
      mode: "daily",
      next_run_at: "2026-06-02T15:00:00.000Z",
      quiet_hours_json: JSON.stringify({ daily: [{ end: "08:00", start: "22:00" }] }),
      time_of_day: "23:00",
      timezone: "Asia/Shanghai"
    }, new Date("2026-06-02T15:00:00Z"));

    expect(resumeAt).toBe("2026-06-03T00:00:00.000Z");
  });
});
