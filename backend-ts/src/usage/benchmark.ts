import { createReadStream } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { createInterface } from "node:readline";
import { addUsage, dayKey, timestamp, tokenUsage, zeroUsage } from "./helpers.ts";
import { readUsageSnapshot, rebuildUsageIndex, resetUsageReaderState } from "./reader.ts";
import type { TokenEvent, TokenUsage, UsageMeta } from "./types.ts";

const root = argument("--root") || `${Bun.env.HOME ?? ""}/.codex/sessions`;
const requestedIndex = argument("--index");
const warmRequests = Math.max(5, Number(argument("--warm-requests") || 20));
const verify = process.argv.includes("--verify");
const temp = requestedIndex ? "" : await mkdtemp(join(tmpdir(), "codex-usage-index-benchmark-"));
const indexPath = requestedIndex || join(temp, "usage-index.sqlite");

try {
  Bun.gc(true);
  const cold = await measured(async () => await rebuildUsageIndex(root, indexPath));
  resetUsageReaderState();
  const restart = await readUsageSnapshot(root, 0, { backgroundRefresh: true, indexPath });
  const refreshed = await readUsageSnapshot(root, 0, { indexPath });

  Bun.gc(true);
  const warmBase = process.memoryUsage.rss();
  const warmLatencies: number[] = [];
  let warmPeak = warmBase;
  for (let index = 0; index < warmRequests; index += 1) {
    const started = performance.now();
    await readUsageSnapshot(root, 0, { backgroundRefresh: true, indexPath });
    warmLatencies.push(performance.now() - started);
    warmPeak = Math.max(warmPeak, process.memoryUsage.rss());
  }
  warmLatencies.sort((left, right) => left - right);
  const verification = verify ? await independentVerification(root, indexPath) : { status: "skipped" };
  const report = {
    schema: "codex.usage-index-benchmark.v1",
    root,
    index_path: indexPath,
    cold_rebuild: {
      duration_ms: cold.durationMs,
      rss_delta_bytes: cold.peakRSS - cold.baseRSS,
      metrics: cold.value
    },
    restart: {
      returned_index_version: restart.freshness.index_version,
      refresh_bytes_read: refreshed.cache.bytes_read,
      reused_files: refreshed.cache.files_reused
    },
    warm: {
      requests: warmRequests,
      p50_ms: percentile(warmLatencies, 0.5),
      p95_ms: percentile(warmLatencies, 0.95),
      rss_delta_bytes: warmPeak - warmBase
    },
    verification,
    budgets: {
      cold_rss_delta_lte_64_mib: cold.peakRSS - cold.baseRSS <= 64 * 1024 * 1024,
      restart_reads_zero_history_bytes: refreshed.cache.bytes_read === 0,
      warm_p95_lte_300_ms: percentile(warmLatencies, 0.95) <= 300,
      warm_rss_delta_lte_32_mib: warmPeak - warmBase <= 32 * 1024 * 1024
    }
  };
  console.log(JSON.stringify(report, null, 2));
  if (Object.values(report.budgets).some((passed) => !passed) || verification.status === "failed") process.exitCode = 1;
} finally {
  if (temp) await rm(temp, { recursive: true, force: true });
}

async function measured<T>(run: () => Promise<T>): Promise<{ baseRSS: number; durationMs: number; peakRSS: number; value: T }> {
  const baseRSS = process.memoryUsage.rss();
  let peakRSS = baseRSS;
  const timer = setInterval(() => { peakRSS = Math.max(peakRSS, process.memoryUsage.rss()); }, 20);
  const started = performance.now();
  try {
    const value = await run();
    peakRSS = Math.max(peakRSS, process.memoryUsage.rss());
    return { baseRSS, durationMs: performance.now() - started, peakRSS, value };
  } finally {
    clearInterval(timer);
  }
}

async function independentVerification(root: string, indexPath: string): Promise<Record<string, unknown>> {
  const expected = new Map<string, { events: number; usage: TokenUsage }>();
  let corruptLines = 0;
  let latestLimits: TokenEvent | undefined;
  let latestUsage: TokenEvent | undefined;
  for (const path of await jsonlFiles(root)) {
    const meta: UsageMeta = { cwd: "", id: "" };
    const reader = createInterface({ crlfDelay: Infinity, input: createReadStream(path, { encoding: "utf8" }) });
    for await (const line of reader) {
      let raw: unknown;
      try { raw = JSON.parse(line); } catch { corruptLines += 1; continue; }
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const value = raw as { payload?: { cwd?: unknown; id?: unknown; type?: unknown }; type?: unknown };
      if (value.type === "session_meta") {
        meta.cwd = typeof value.payload?.cwd === "string" ? value.payload.cwd.trim() : "";
        meta.id = typeof value.payload?.id === "string" ? value.payload.id.trim() : "";
        continue;
      }
      if (value.type !== "event_msg" || value.payload?.type !== "token_count") continue;
      const event = raw as TokenEvent;
      if (event.payload?.rate_limits && isLater(event, latestLimits)) latestLimits = event;
      if (event.payload?.info && isLater(event, latestUsage)) latestUsage = event;
      if (!event.payload?.info) continue;
      const key = `${dayKey(timestamp(event))}\0${meta.cwd}\0${meta.id}`;
      const bucket = expected.get(key) ?? { events: 0, usage: zeroUsage() };
      bucket.events += 1;
      addUsage(bucket.usage, tokenUsage(event.payload.info.last_token_usage));
      expected.set(key, bucket);
    }
  }
  const actual = await readUsageSnapshot(root, 0, { indexPath });
  const actualMap = new Map(actual.buckets.map((bucket) => [
    `${dayKey(new Date(bucket.timestamp))}\0${bucket.meta.cwd}\0${bucket.meta.id}`,
    { events: bucket.events, usage: bucket.usage }
  ]));
  const mismatches = [...new Set([...expected.keys(), ...actualMap.keys()])]
    .filter((key) => JSON.stringify(expected.get(key)) !== JSON.stringify(actualMap.get(key)))
    .slice(0, 20);
  const latestUsageMatches = JSON.stringify(compactLatestUsage(latestUsage)) === JSON.stringify(compactLatestUsage(actual.latestUsage?.event));
  const latestLimitsMatch = JSON.stringify(latestLimits?.payload?.rate_limits ?? null) ===
    JSON.stringify(actual.latestLimits?.event.payload?.rate_limits ?? null);
  return {
    actual_buckets: actualMap.size,
    corrupt_lines: corruptLines,
    expected_buckets: expected.size,
    latest_limits_match: latestLimitsMatch,
    latest_usage_match: latestUsageMatches,
    mismatch_samples: mismatches,
    status: mismatches.length === 0 && actual.cache.corrupt_lines === corruptLines && latestLimitsMatch && latestUsageMatches
      ? "passed"
      : "failed"
  };
}

function isLater(candidate: TokenEvent, current: TokenEvent | undefined): boolean {
  return !current || timestamp(candidate).getTime() > timestamp(current).getTime();
}

function compactLatestUsage(event: TokenEvent | undefined): Record<string, unknown> | null {
  if (!event?.payload?.info) return null;
  return {
    captured_at: timestamp(event).toISOString(),
    last_token_usage: tokenUsage(event.payload.info.last_token_usage),
    model_context_window: event.payload.info.model_context_window ?? 0,
    total_token_usage: tokenUsage(event.payload.info.total_token_usage)
  };
}

async function jsonlFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  await collect(root, files);
  return files.sort();
}

async function collect(dir: string, files: string[]): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await collect(path, files);
    else if (entry.isFile() && extname(entry.name) === ".jsonl") files.push(path);
  }
}

function percentile(values: number[], ratio: number): number {
  return values[Math.max(0, Math.ceil(values.length * ratio) - 1)] ?? 0;
}

function argument(name: string): string {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1]?.trim() ?? "" : "";
}
