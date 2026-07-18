#!/usr/bin/env bun
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  capacityReportMarkdown,
  generateCapacityDataset,
  runCapacityBenchmark,
  snapshotDatabase,
  type CapacityReport,
  type DatasetScale
} from "../backend-ts/src/benchmarks/xuanwuCapacity.ts";
import { openDatabase } from "../backend-ts/src/db/database.ts";

type Flags = Record<string, string | boolean>;

async function main(): Promise<void> {
  const command = Bun.argv[2]?.trim();
  const flags = parseFlags(Bun.argv.slice(3));
  if (command === "snapshot") {
    allowOnly(flags, ["output", "source"]);
    const output = resolve(required(flags, "output"));
    await mkdir(dirname(output), { recursive: true });
    const result = await snapshotDatabase(resolve(required(flags, "source")), output);
    const migrated = await openDatabase({ dbPath: output, stateDir: dirname(output) });
    const migrationCount = migrated.sqlite.query<{ count: number }, []>(
      "select count(*) as count from schema_migrations"
    ).get()?.count ?? 0;
    migrated.close();
    print({ ...result, migration_count: migrationCount, source: "consistent SQLite serialization" });
    return;
  }
  if (command === "generate") {
    allowOnly(flags, [
      "automation-events", "automation-runs", "automations", "events", "issues",
      "output", "projects", "runs", "sessions"
    ]);
    const output = resolve(required(flags, "output"));
    await mkdir(dirname(output), { recursive: true });
    print(await generateCapacityDataset(output, datasetScale(flags)));
    return;
  }
  if (command === "run") {
    allowOnly(flags, [
      "baseline", "confirm-copy", "db", "json-out", "label", "markdown-out", "samples", "warmups"
    ]);
    if (flags["confirm-copy"] !== true) {
      throw new Error("run requires --confirm-copy; benchmark migrations/projections may write and must never target the live DB");
    }
    const baseline = flags.baseline
      ? JSON.parse(await readFile(resolve(String(flags.baseline)), "utf8")) as CapacityReport
      : undefined;
    const report = await runCapacityBenchmark({
      ...(baseline ? { baseline } : {}),
      dbPath: resolve(required(flags, "db")),
      label: optional(flags, "label"),
      samples: optionalInteger(flags, "samples"),
      warmups: optionalInteger(flags, "warmups")
    });
    await writeReport(flags, report);
    print(report);
    if (report.status !== "passed") process.exitCode = 1;
    return;
  }
  throw new Error("usage: xuanwu-capacity-benchmark.ts <snapshot|generate|run> [flags]");
}

function datasetScale(flags: Flags): Partial<DatasetScale> {
  return {
    ...integerEntry(flags, "projects", "projects"),
    ...integerEntry(flags, "issues", "issues_per_project"),
    ...integerEntry(flags, "events", "events_per_issue"),
    ...integerEntry(flags, "runs", "runs_per_issue"),
    ...integerEntry(flags, "sessions", "sessions_per_issue"),
    ...integerEntry(flags, "automations", "automations_per_project"),
    ...integerEntry(flags, "automation-runs", "automation_runs_per_automation"),
    ...integerEntry(flags, "automation-events", "automation_events_per_automation")
  };
}

function integerEntry(flags: Flags, flag: string, key: keyof DatasetScale): Partial<DatasetScale> {
  const value = optionalInteger(flags, flag);
  return value === undefined ? {} : { [key]: value };
}

async function writeReport(flags: Flags, report: CapacityReport): Promise<void> {
  const jsonPath = optional(flags, "json-out");
  const markdownPath = optional(flags, "markdown-out");
  if (jsonPath) {
    const target = resolve(jsonPath);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }
  if (markdownPath) {
    const target = resolve(markdownPath);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, capacityReportMarkdown(report), "utf8");
  }
}

function parseFlags(args: string[]): Flags {
  const flags: Flags = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (!arg.startsWith("--")) throw new Error(`unexpected argument: ${arg}`);
    const name = arg.slice(2);
    if (name === "confirm-copy") {
      flags[name] = true;
      continue;
    }
    const value = args[++index];
    if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
    flags[name] = value;
  }
  return flags;
}

function allowOnly(flags: Flags, allowed: string[]): void {
  const unexpected = Object.keys(flags).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) throw new Error(`unknown flags: ${unexpected.map((key) => `--${key}`).join(", ")}`);
}

function required(flags: Flags, key: string): string {
  const value = optional(flags, key);
  if (!value) throw new Error(`--${key} is required`);
  return value;
}

function optional(flags: Flags, key: string): string | undefined {
  const value = flags[key];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function optionalInteger(flags: Flags, key: string): number | undefined {
  const value = optional(flags, key);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`--${key} must be an integer`);
  return parsed;
}

function print(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

await main();
