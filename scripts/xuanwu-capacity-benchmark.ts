#!/usr/bin/env bun
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import {
  capacityReportMarkdown,
  evaluateRunnerMemoryCapacity,
  generateCapacityDataset,
  RUNNER_MEMORY_CAPACITY_PHASES,
  runCapacityBenchmark,
  snapshotDatabase,
  type CapacityReport,
  type DatasetScale,
  type RunnerMemoryCapacitySample
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
  if (command === "memory-run") {
    allowOnly(flags, ["baseline-evidence", "json-out", "reviewed-by", "samples-file"]);
    const samples = JSON.parse(await readFile(resolve(required(flags, "samples-file")), "utf8")) as unknown;
    if (!Array.isArray(samples)) throw new Error("--samples-file must contain one JSON array");
    const report = evaluateRunnerMemoryCapacity({
      baselineEvidenceId: required(flags, "baseline-evidence"),
      reviewedBy: required(flags, "reviewed-by"),
      samples: samples as RunnerMemoryCapacitySample[]
    });
    const jsonPath = optional(flags, "json-out");
    if (jsonPath) {
      const target = resolve(jsonPath);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    }
    print(report);
    if (report.status !== "passed") process.exitCode = 1;
    return;
  }
  if (command === "memory-capture") {
    allowOnly(flags, ["addr", "cycle", "duration-seconds", "interval-ms", "output", "phase"]);
    const output = resolve(required(flags, "output"));
    const captured = await captureRunnerMemory({
      addr: optional(flags, "addr") ?? Bun.env.CODEX_RUNNER_ADDR ?? "127.0.0.1:3008",
      cycle: optionalInteger(flags, "cycle"),
      durationSeconds: optionalInteger(flags, "duration-seconds") ?? 0,
      intervalMs: optionalInteger(flags, "interval-ms") ?? 1_000,
      phase: required(flags, "phase") as RunnerMemoryCapacitySample["phase"]
    });
    const existing = await readSamples(output);
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, `${JSON.stringify([...existing, ...captured], null, 2)}\n`, "utf8");
    print({ captured: captured.length, output: basename(output) });
    return;
  }
  throw new Error("usage: xuanwu-capacity-benchmark.ts <snapshot|generate|run|memory-capture|memory-run> [flags]");
}

async function captureRunnerMemory(input: {
  addr: string;
  cycle?: number;
  durationSeconds: number;
  intervalMs: number;
  phase: RunnerMemoryCapacitySample["phase"];
}): Promise<RunnerMemoryCapacitySample[]> {
  const allowed = new Set<string>(RUNNER_MEMORY_CAPACITY_PHASES);
  if (!allowed.has(input.phase)) throw new Error(`invalid memory phase: ${input.phase}`);
  if (input.durationSeconds < 0 || input.intervalMs < 250) throw new Error("duration must be >= 0 and interval must be >= 250 ms");
  const deadline = Date.now() + input.durationSeconds * 1_000;
  const samples: RunnerMemoryCapacitySample[] = [];
  do {
    const base = /^https?:\/\//.test(input.addr) ? input.addr : `http://${input.addr}`;
    const response = await fetch(`${base.replace(/\/$/, "")}/api/system/status`, {
      headers: authHeaders()
    });
    if (!response.ok) throw new Error(`system status returned HTTP ${response.status}`);
    const status = await response.json() as Record<string, unknown>;
    const memory = object(status.process_group_memory);
    const aggregate = object(memory.aggregate);
    const freshness = object(memory.freshness);
    const main = object(memory.main);
    samples.push({
      ...(input.cycle === undefined ? {} : { cycle: input.cycle }),
      footprint_bytes: nullableNumber(aggregate.footprint_bytes),
      freshness_status: String(freshness.status ?? "unknown"),
      group_rss_bytes: requiredNumber(aggregate.rss_bytes, "aggregate.rss_bytes"),
      main_array_buffers_bytes: requiredNumber(main.array_buffers_bytes, "main.array_buffers_bytes"),
      main_external_bytes: requiredNumber(main.external_bytes, "main.external_bytes"),
      main_heap_used_bytes: requiredNumber(main.heap_used_bytes, "main.heap_used_bytes"),
      main_process_rss_bytes: requiredNumber(main.process_rss_bytes, "main.process_rss_bytes"),
      main_ps_rss_bytes: requiredNumber(main.ps_rss_bytes, "main.ps_rss_bytes"),
      observed_at: String(memory.sampled_at ?? new Date().toISOString()),
      phase: input.phase,
      sample_age_ms: requiredNumber(freshness.age_ms, "freshness.age_ms")
    });
    if (Date.now() >= deadline) break;
    await Bun.sleep(Math.min(input.intervalMs, Math.max(0, deadline - Date.now())));
  } while (true);
  return samples;
}

async function readSamples(path: string): Promise<RunnerMemoryCapacitySample[]> {
  try {
    const text = await readFile(path, "utf8");
    if (text.trim() === "") return [];
    const parsed = JSON.parse(text) as unknown;
    if (!Array.isArray(parsed)) throw new Error("existing output must contain one JSON array");
    return parsed as RunnerMemoryCapacitySample[];
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}

function authHeaders(): Record<string, string> {
  const token = Bun.env.CODEX_RUNNER_AUTH_TOKEN?.trim() ?? "";
  return token === "" ? {} : { authorization: `Bearer ${token}` };
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function requiredNumber(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${field} is unavailable`);
  return parsed;
}

function nullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : requiredNumber(value, "footprint_bytes");
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
