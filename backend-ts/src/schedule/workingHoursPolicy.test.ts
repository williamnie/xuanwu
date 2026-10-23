import { describe, expect, test } from "bun:test";
import { quietHoursResumeAt } from "./cronSchedule.ts";

describe("Working hours schedule policy", () => {

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
