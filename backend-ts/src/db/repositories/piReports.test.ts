import { describe, expect, test } from "bun:test";
import { createPiReportRecord, listPiReportRecords } from "./pi.ts";
import { useTestDatabase } from "../../testing/harness.ts";

const openFixtureDatabase = useTestDatabase();

describe("PI report repository", () => {
  test("persists report model fields and filters by delegation/source/status", async () => {
    const db = await openFixtureDatabase();
    const report = createPiReportRecord(db, {
      body_json: JSON.stringify({ project_id: "demo" }),
      delegation_id: "delegation-a",
      heartbeat_id: "heartbeat-a",
      issue_ids_json: JSON.stringify([101, 102]),
      project_id: "demo",
      since_at: "2026-06-03T20:00:00Z",
      source: "delegation",
      status: "generated",
      summary_json: JSON.stringify({ total: 2 }),
      type: "night_run_summary",
      until_at: "2026-06-04T08:00:00Z"
    });
    createPiReportRecord(db, {
      delegation_id: "delegation-b",
      project_id: "demo",
      source: "cron_schedule",
      status: "generated",
      type: "daily_project_digest"
    });

    expect(report).toMatchObject({
      delegation_id: "delegation-a",
      heartbeat_id: "heartbeat-a",
      project_id: "demo",
      since_at: "2026-06-03T20:00:00Z",
      source: "delegation",
      status: "generated",
      type: "night_run_summary",
      until_at: "2026-06-04T08:00:00Z"
    });
    expect(JSON.parse(report.issue_ids_json)).toEqual([101, 102]);

    const reports = listPiReportRecords(db, {
      delegationId: "delegation-a",
      heartbeatId: "heartbeat-a",
      projectId: "demo",
      source: "delegation",
      status: "generated"
    });
    expect(reports.map((item) => item.id)).toEqual([report.id]);
  });
});
