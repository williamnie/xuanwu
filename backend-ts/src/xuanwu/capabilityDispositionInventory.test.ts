import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { runMigrations } from "../db/migrations.ts";
import { AUTOMATION_LEGACY_REDIRECT_ROUTES } from "../http/automationLegacyRedirectsApi.ts";
import {
  API_ROUTE_DISPOSITIONS,
  API_ROUTE_FAMILIES,
  LIVE_REFERENCE,
  MIGRATION_GATES,
  PAGE_SURFACES,
  PI_MODULE_FAMILIES,
  RETENTION_LEVELS,
  SCHEDULER_DISPOSITIONS,
  TABLE_DISPOSITIONS
} from "./capabilityDispositionInventory.ts";

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const ADR_PATH = "docs/architecture/xuanwu/0005-capability-disposition-inventory.md";

describe("Xuanwu capability disposition inventory", () => {
  test("covers every current source table and the two live-only legacy tables", () => {
    expect(TABLE_DISPOSITIONS).toHaveLength(96);
    expect(unique(TABLE_DISPOSITIONS.map((item) => item.name))).toHaveLength(96);
    expect(Object.keys(RETENTION_LEVELS).sort()).toEqual([
      "R0_DERIVED",
      "R1_OPERATIONAL",
      "R2_DURABLE",
      "R3_AUDIT",
      "R4_SENSITIVE"
    ]);

    const sqlite = new Database(":memory:");
    try {
      runMigrations(sqlite);
      const sourceTables = sqlite.query<{ name: string }, []>(`
        select name from sqlite_master
        where type='table' and name not like 'sqlite_%'
        order by name
      `).all().map((row) => row.name);
      const inventoriedSourceTables: string[] = TABLE_DISPOSITIONS
        .filter((item) => item.runtime_origin === "source_schema")
        .map((item) => item.name)
        .sort();
      expect(inventoriedSourceTables).toEqual(sourceTables);
    } finally {
      sqlite.close();
    }

    expect(TABLE_DISPOSITIONS.filter((item) => item.runtime_origin === "live_legacy_only").map((item) => item.name))
      .toEqual(["nightly_batch_items", "nightly_batches"]);
  });

  test("matches the live database table set when XUANWU_LIVE_DB is provided", () => {
    const path = process.env.XUANWU_LIVE_DB?.trim() ?? "";
    if (path === "") return;
    expect(existsSync(path)).toBe(true);

    const sqlite = new Database(path, { readonly: true, strict: true });
    try {
      const liveTables = sqlite.query<{ name: string }, []>(`
        select name from sqlite_master
        where type='table' and name not like 'sqlite_%'
        order by name
      `).all().map((row) => row.name);
      expect(liveTables).toEqual(TABLE_DISPOSITIONS.map((item) => item.name).sort());
      expect(liveTables).toHaveLength(LIVE_REFERENCE.table_count);
    } finally {
      sqlite.close();
    }
  });

  test("covers every literal user API route registered by production HTTP modules", () => {
    const routes = productionHttpRoutes();
    const inventoried = API_ROUTE_DISPOSITIONS.map((route) => `${route.method} ${route.path}`).sort();
    expect(inventoried).toEqual(routes);
    expect(inventoried).toHaveLength(260);
    expect(unique(inventoried)).toHaveLength(inventoried.length);

    const familyIDs = new Set(API_ROUTE_FAMILIES.map((family) => family.id));
    for (const route of API_ROUTE_DISPOSITIONS) expect(familyIDs.has(route.family)).toBe(true);
    for (const family of API_ROUTE_FAMILIES) {
      expect(API_ROUTE_DISPOSITIONS.some((route) => route.family === family.id)).toBe(true);
      expect(family.source_of_truth).not.toBe("");
      expect(family.target).not.toBe("");
    }
  });

  test("assigns every production page component and PI module exactly once", () => {
    const pageFiles = productionFiles("frontend/src/pages", (name) => name.endsWith(".jsx"));
    const inventoriedPages: string[] = PAGE_SURFACES.flatMap((surface) => [...surface.source_files]).sort();
    expect(inventoriedPages).toEqual(pageFiles);
    expect(unique(inventoriedPages)).toHaveLength(inventoriedPages.length);
    expect(unique(PAGE_SURFACES.flatMap((surface) => surface.page_ids))).toHaveLength(
      PAGE_SURFACES.flatMap((surface) => surface.page_ids).length
    );

    const piFiles = productionFiles(
      "backend-ts/src/pi",
      (name) => name.endsWith(".ts") && !name.endsWith(".test.ts")
    );
    const inventoriedPi: string[] = PI_MODULE_FAMILIES.flatMap((family) => [...family.source_files]).sort();
    expect(inventoriedPi).toEqual(piFiles);
    expect(inventoriedPi).toHaveLength(154);
    expect(unique(inventoriedPi)).toHaveLength(inventoriedPi.length);
  });

  test("keeps schedulers mapped and gives every delete item reproducible evidence and gates", () => {
    expect(SCHEDULER_DISPOSITIONS).toHaveLength(12);
    for (const scheduler of SCHEDULER_DISPOSITIONS) {
      expect(readFileSync(resolve(REPO_ROOT, scheduler.source_file), "utf8")).toContain(
        scheduler.entrypoint.split(" + ")[0].split(" / ")[0]
      );
    }
    expect(SCHEDULER_DISPOSITIONS.filter((item) => item.entrypoint === "runDueAutomations")).toEqual([
      expect.objectContaining({ id: "target-automation-dispatch", disposition: "keep" })
    ]);
    expect(SCHEDULER_DISPOSITIONS.some((item) => item.entrypoint.startsWith("runDuePiAutomations"))).toBe(false);

    const deleteItems = TABLE_DISPOSITIONS.filter((item) => item.disposition === "delete");
    expect(deleteItems.map((item) => item.name)).toEqual(["nightly_batch_items", "nightly_batches"]);
    const productionSources = productionSourceText();
    for (const item of deleteItems) {
      expect(item.runtime_origin).toBe("live_legacy_only");
      expect(item.live_rows).toBeGreaterThan(0);
      expect(item.delete_preconditions.length).toBeGreaterThanOrEqual(3);
      expect(productionSources).not.toContain(item.name);
    }
  });

  test("locks canonical source-of-truth, dual-read/write, rollback, and final-delete gates", () => {
    expect(MIGRATION_GATES.source_of_truth).toContain("唯一写 authority");
    expect(MIGRATION_GATES.dual_write).toContain("默认禁止");
    expect(MIGRATION_GATES.dual_read).toContain("shadow comparison");
    expect(MIGRATION_GATES.rollback).toContain("恢复旧读");
    expect(MIGRATION_GATES.final_delete).toContain("备份恢复演练");

    const adr = readFileSync(resolve(REPO_ROOT, ADR_PATH), "utf8");
    for (const heading of ["live reference", "表清单", "API 清单", "页面清单", "后台调度器", "PI 模块", "删除前置条件"]) {
      expect(adr).toContain(heading);
    }
    expect(adr).toContain("93 张表");
    expect(adr).toContain("257 条用户 API route");
  });
});

function productionHttpRoutes(): string[] {
  const directory = resolve(REPO_ROOT, "backend-ts/src/http");
  const routes = new Set<string>();
  const pattern = /\brouter\.(get|post|put|patch|delete)\(\s*(["'`])([^"'`]+)\2/gi;
  for (const name of readdirSync(directory).filter((item) => item.endsWith(".ts") && !item.endsWith(".test.ts"))) {
    const source = readFileSync(join(directory, name), "utf8");
    for (const match of source.matchAll(pattern)) {
      const path = match[3];
      if (path.startsWith("/api/")) routes.add(`${match[1].toUpperCase()} ${path}`);
    }
  }
  for (const [method, path] of AUTOMATION_LEGACY_REDIRECT_ROUTES) routes.add(`${method} ${path}`);
  return [...routes].sort();
}

function productionFiles(directory: string, include: (name: string) => boolean): string[] {
  return readdirSync(resolve(REPO_ROOT, directory))
    .filter(include)
    .map((name) => `${directory}/${name}`)
    .sort();
}

function productionSourceText(): string {
  const roots = ["backend-ts/src", "frontend/src"];
  const files = roots.flatMap((directory) => walk(resolve(REPO_ROOT, directory)))
    .filter((path) => !path.includes(".test."))
    .filter((path) => !path.endsWith("/capabilityDispositionInventory.ts"))
    .filter((path) => !path.endsWith("/capabilityDispositionInventory.test.ts"))
    .filter((path) => !path.endsWith("/automationSemantics.ts"))
    .filter((path) => !path.endsWith("/automationSemantics.test.ts"))
    .filter((path) => !path.endsWith("/consolidationAudit.ts"))
    .filter((path) => !path.endsWith("/053_drop_legacy_automation_tables.ts"))
    .filter((path) => [".js", ".jsx", ".ts", ".tsx"].includes(extname(path)));
  return files.map((path) => readFileSync(path, "utf8")).join("\n");
}

function walk(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}
