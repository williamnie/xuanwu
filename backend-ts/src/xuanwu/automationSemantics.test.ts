import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runMigrations } from "../db/migrations.ts";
import { API_ROUTE_DISPOSITIONS, TABLE_DISPOSITIONS } from "./capabilityDispositionInventory.ts";
import {
  AUTOMATION_API_ROUTES,
  AUTOMATION_CARRIERS,
  AUTOMATION_MIGRATION_CONTRACT,
  AUTOMATION_SCHEDULE_CYCLE_ENTRYPOINTS,
  AUTOMATION_STATUS_MAPPINGS,
  AUTOMATION_TABLES,
  AUTOMATION_TARGET_TABLES
} from "./automationSemantics.ts";

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const ADR_PATH = resolve(REPO_ROOT, "docs/architecture/xuanwu/0060-automation-semantics.md");

describe("Xuanwu Automation semantics", () => {
  test("classifies every automation/watch table and keeps current authorities explicit", () => {
    expect(AUTOMATION_TABLES).toEqual([
      "cron_tasks", "cron_task_schedules", "pi_automations", "pi_delegations",
      "pi_heartbeat_controls", "pi_heartbeat_runs", "pi_heartbeat_events",
      "pi_issue_completion_watches", "pi_issue_completion_watch_items",
      "nightly_batches", "nightly_batch_items"
    ]);
    expect(new Set(AUTOMATION_TABLES).size).toBe(AUTOMATION_TABLES.length);

    const inventoried = new Set(TABLE_DISPOSITIONS.map((item) => item.name));
    for (const carrier of AUTOMATION_CARRIERS) {
      expect(["trigger", "execution", "observation", "archive"]).toContain(carrier.role);
      expect(carrier.current_authority).not.toBe("");
      expect(carrier.target_semantics).not.toBe("");
      expect(carrier.rollback).not.toBe("");
      expect(carrier.final_delete_gate).toContain("P11");
      for (const table of carrier.tables) expect(inventoried.has(table)).toBe(true);
      for (const source of carrier.source_files) expect(existsSync(resolve(REPO_ROOT, source))).toBe(true);
    }
  });

  test("freezes the exact target tables and all schedule-cycle writers/consumers", () => {
    expect(AUTOMATION_TARGET_TABLES).toEqual([
      "automation_definitions", "automation_trigger_configs", "automation_runs", "automation_events",
      "automation_run_events", "automation_execution_links", "automation_watches"
    ]);
    const sqlite = new Database(":memory:");
    try {
      runMigrations(sqlite);
      const sourceTables = new Set(sqlite.query<{ name: string }, []>(
        "select name from sqlite_master where type='table'"
      ).all().map((row) => row.name));
      expect(AUTOMATION_TARGET_TABLES.filter((table) => !sourceTables.has(table))).toEqual([]);
    } finally {
      sqlite.close();
    }

    expect(AUTOMATION_SCHEDULE_CYCLE_ENTRYPOINTS.map((item) => item.entrypoint)).toEqual([
      "runDueCronTasks", "runDuePiAutomations", "runDueAutomations", "runDelegationHeartbeatsOnce",
      "runWatchAutomationsOnce", "queueReadyFeishuCompletionWatchNotifications"
    ]);
    const scheduler = readFileSync(resolve(REPO_ROOT, "backend-ts/src/runner/piAutoManageScheduler.ts"), "utf8");
    const actualCalls = AUTOMATION_SCHEDULE_CYCLE_ENTRYPOINTS
      .filter((item) => new RegExp(`\\b${item.entrypoint}\\s*\\(`).test(scheduler))
      .map((item) => item.entrypoint);
    expect(actualCalls).toEqual(AUTOMATION_SCHEDULE_CYCLE_ENTRYPOINTS.map((item) => item.entrypoint));
    expect(new Set(AUTOMATION_SCHEDULE_CYCLE_ENTRYPOINTS.map((item) => item.carrier)).size)
      .toBe(AUTOMATION_SCHEDULE_CYCLE_ENTRYPOINTS.length);

    expect(TABLE_DISPOSITIONS.find((item) => item.name === "pi_automations")).toMatchObject({
      disposition: "migrate",
      target: "automation_definitions target authority"
    });
  });

  test("covers all 34 automation API routes and marks every mutation", () => {
    const expected = API_ROUTE_DISPOSITIONS
      .filter((route) => route.family === "automation")
      .map((route) => `${route.method} ${route.path}`)
      .sort();
    const actual = AUTOMATION_API_ROUTES.map((route) => `${route.method} ${route.path}`).sort();
    expect(actual).toEqual(expected);
    expect(actual).toHaveLength(34);
    expect(new Set(actual).size).toBe(actual.length);
    expect(AUTOMATION_API_ROUTES.filter((route) => route.write)).toHaveLength(22);
    expect(AUTOMATION_API_ROUTES.filter((route) => !route.write)).toHaveLength(12);
    for (const route of AUTOMATION_API_ROUTES) {
      expect(route.write).toBe(route.method !== "GET");
      expect(["definition", "trigger", "control", "observation"]).toContain(route.role);
    }
  });

  test("maps lifecycle, execution, observation, and archived statuses without collapsing their axes", () => {
    const axes = new Set(AUTOMATION_STATUS_MAPPINGS.map((mapping) => mapping.semantic_axis));
    expect([...axes].sort()).toEqual(["archive", "definition", "execution", "observation"]);
    const identities = AUTOMATION_STATUS_MAPPINGS.map((mapping) =>
      `${mapping.carrier}:${mapping.field}:${mapping.source_status}`
    );
    expect(new Set(identities).size).toBe(identities.length);
    expect(AUTOMATION_STATUS_MAPPINGS).toContainEqual(expect.objectContaining({
      carrier: "completion_watch", source_status: "notified", canonical_status: "delivered"
    }));
    expect(AUTOMATION_STATUS_MAPPINGS).toContainEqual(expect.objectContaining({
      carrier: "heartbeat", source_status: "completed", canonical_status: "succeeded"
    }));
  });

  test("locks authority, bounded dual mode, rollback, deterministic permission, order, and deletion gates", () => {
    expect(AUTOMATION_MIGRATION_CONTRACT.current_gate).toBe("G0");
    expect(AUTOMATION_MIGRATION_CONTRACT.current_window).toBe("W1");
    expect(AUTOMATION_MIGRATION_CONTRACT.target_authority).toContain("automation_definitions");
    expect(AUTOMATION_MIGRATION_CONTRACT.target_authority).toContain("pi_automations remains legacy-primary");
    expect(AUTOMATION_MIGRATION_CONTRACT.dual_read).toContain("at most two");
    expect(AUTOMATION_MIGRATION_CONTRACT.dual_write).toContain("Default forbidden");
    expect(AUTOMATION_MIGRATION_CONTRACT.rollback).toContain("restor");
    expect(AUTOMATION_MIGRATION_CONTRACT.permission).toContain("cannot approve");
    expect(AUTOMATION_MIGRATION_CONTRACT.notification_boundary).toContain("None of them proves Work completion");
    expect(AUTOMATION_MIGRATION_CONTRACT.migration_order).toHaveLength(6);
    expect(AUTOMATION_MIGRATION_CONTRACT.migration_order.at(-1)).toContain("P11/G7");
  });

  test("canonical ADR records duplication, migration, API coverage, and fresh live sample", () => {
    const adr = readFileSync(ADR_PATH, "utf8");
    for (const heading of ["触发 / 执行 / 观察分类", "状态映射", "重复能力", "迁移顺序", "删除门禁", "live records 抽样", "API 覆盖"]) {
      expect(adr).toContain(heading);
    }
    expect(adr).toContain("34");
    expect(adr).toContain("11 张表");
    expect(adr).toContain("W1 + W2 最多两个连续正式 release");
  });

  test("samples live carrier records read-only when XUANWU_LIVE_DB is provided", () => {
    const path = process.env.XUANWU_LIVE_DB?.trim() ?? "";
    if (path === "") return;
    expect(existsSync(path)).toBe(true);
    const sqlite = new Database(path, { readonly: true, strict: true });
    try {
      const tables = new Set(sqlite.query<{ name: string }, []>(
        "select name from sqlite_master where type='table' and name not like 'sqlite_%'"
      ).all().map((row) => row.name));
      for (const table of AUTOMATION_TABLES) expect(tables.has(table)).toBe(true);
      expectUnknownStatuses(sqlite, "cron_tasks", "status", statuses("cron", "status"));
      expectUnknownStatuses(sqlite, "cron_tasks", "last_status", ["", ...statuses("cron", "last_status")]);
      expectUnknownStatuses(sqlite, "pi_automations", "enabled", statuses("pi_automation", "enabled"));
      expectUnknownStatuses(sqlite, "pi_automations", "last_status", ["", ...statuses("pi_automation", "last_status")]);
      expectUnknownStatuses(sqlite, "pi_delegations", "status", statuses("delegation", "status"));
      expectUnknownStatuses(sqlite, "pi_heartbeat_runs", "status", statuses("heartbeat", "status"));
      expectUnknownStatuses(sqlite, "pi_issue_completion_watches", "status", statuses("completion_watch", "status"));
      expectUnknownStatuses(sqlite, "nightly_batches", "status", statuses("nightly_batch", "status"));
      expectUnknownStatuses(sqlite, "nightly_batch_items", "status", statuses("nightly_batch", "item.status"));
    } finally {
      sqlite.close();
    }
  });

  test("current source schema contains every non-legacy carrier table", () => {
    const sqlite = new Database(":memory:");
    try {
      runMigrations(sqlite);
      const sourceTables = new Set(sqlite.query<{ name: string }, []>(
        "select name from sqlite_master where type='table' and name not like 'sqlite_%'"
      ).all().map((row) => row.name));
      for (const table of AUTOMATION_TABLES.filter((name) => !name.startsWith("nightly_"))) {
        expect(sourceTables.has(table)).toBe(true);
      }
      expect(sourceTables.has("nightly_batches")).toBe(false);
      expect(sourceTables.has("nightly_batch_items")).toBe(false);
    } finally {
      sqlite.close();
    }
  });
});

function statuses(carrier: string, field: string): string[] {
  return AUTOMATION_STATUS_MAPPINGS
    .filter((mapping) => mapping.carrier === carrier && mapping.field === field)
    .map((mapping) => mapping.source_status);
}

function expectUnknownStatuses(sqlite: Database, table: string, column: string, allowed: string[]): void {
  const actual = sqlite.query<{ status: string }, []>(
    `select distinct cast(${column} as text) as status from ${table} order by status`
  ).all().map((row) => row.status);
  expect(actual.filter((status) => !allowed.includes(status))).toEqual([]);
}
