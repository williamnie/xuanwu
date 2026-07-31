import { readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { Database } from "bun:sqlite";
import { addUsage, dayKey, isoWeekKey, monthKey, zeroUsage } from "./helpers.ts";
import type { TokenUsage } from "./types.ts";

export type PiUsageSessionRef = {
  conversation_id: string;
  project_id: string;
  session_file: string;
};

type PiUsage = TokenUsage & {
  cache_write_input_tokens: number;
  uncached_input_tokens: number;
};

type PiUsageBucket = {
  assistant_calls: number;
  usage: PiUsage;
};

type CachedSessionUsage = {
  corrupt_lines: number;
  days: Array<{ assistant_calls: number; key: string; usage: PiUsage }>;
  mtime_ms: number;
  size: number;
};

const MAX_DAILY_PERIODS = 31;
const WORKER_TIMEOUT_MS = 60_000;
const sessionUsageCache = new Map<string, CachedSessionUsage>();

export async function readPiUsageForDatabase(databasePath: string): Promise<Record<string, unknown>> {
  const database = new Database(databasePath, { readonly: true, strict: true });
  try {
    const sessions = database.query<PiUsageSessionRef, []>(`
      select id as conversation_id, project_id, session_file
      from pi_conversations where session_file <> ''
    `).all();
    return await readPiUsage({ sessions });
  } finally {
    database.close();
  }
}

export async function readPiUsageInWorker(databasePath: string): Promise<Record<string, unknown>> {
  const workerArgs = ["__pi-usage-worker", databasePath, String(process.pid)];
  const command = basename(process.execPath).startsWith("bun")
    ? [process.execPath, join(import.meta.dir, "../main.ts"), ...workerArgs]
    : [process.execPath, ...workerArgs];
  const child = Bun.spawn({
    cmd: command,
    env: workerEnvironment(),
    stderr: "pipe",
    stdout: "pipe"
  });
  const timeout = setTimeout(() => child.kill(), WORKER_TIMEOUT_MS);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited
  ]).finally(() => clearTimeout(timeout));
  if (exitCode !== 0) throw new Error(`PI usage worker failed (${exitCode}): ${stderr.trim() || stdout.trim()}`);
  const parsed = JSON.parse(stdout) as { ok?: boolean; report?: Record<string, unknown> };
  if (!parsed.ok || !parsed.report) throw new Error("PI usage worker returned an invalid result");
  return parsed.report;
}

export async function readPiUsage(input: {
  now?: Date;
  sessions: PiUsageSessionRef[];
}): Promise<Record<string, unknown>> {
  const now = input.now ?? new Date();
  const daily = new Map<string, PiUsageBucket>();
  const projects = new Map<string, {
    assistant_calls: number;
    sessions: number;
    usage: PiUsage;
  }>();
  const liveFiles = new Set<string>();
  let assistantCalls = 0;
  let corruptLines = 0;
  let filesMissing = 0;
  let sessionsScanned = 0;

  for (const session of uniqueSessions(input.sessions)) {
    liveFiles.add(session.session_file);
    const usage = await readSessionUsage(session.session_file);
    if (!usage) {
      filesMissing += 1;
      continue;
    }
    sessionsScanned += 1;
    corruptLines += usage.corrupt_lines;
    const project = mapProjectUsage(projects, session.project_id);
    project.sessions += 1;
    for (const bucket of usage.days) {
      const target = mapBucket(daily, bucket.key);
      target.assistant_calls += bucket.assistant_calls;
      addPiUsage(target.usage, bucket.usage);
      project.assistant_calls += bucket.assistant_calls;
      addPiUsage(project.usage, bucket.usage);
      assistantCalls += bucket.assistant_calls;
    }
  }
  for (const path of sessionUsageCache.keys()) {
    if (!liveFiles.has(path)) sessionUsageCache.delete(path);
  }
  const summary = {
    all_time: aggregateBuckets(daily.values()),
    this_month: aggregateMatching(daily, (key) => key.startsWith(monthKey(now))),
    this_week: aggregateMatching(daily, (key) => isoWeekKey(new Date(`${key}T12:00:00`)) === isoWeekKey(now)),
    today: aggregateMatching(daily, (key) => key === dayKey(now))
  };
  return {
    assistant_calls: assistantCalls,
    completeness: filesMissing === 0 && corruptLines === 0 ? "complete" : "partial",
    corrupt_lines: corruptLines,
    daily: [...daily.entries()].sort(([left], [right]) => left.localeCompare(right)).slice(-MAX_DAILY_PERIODS)
      .map(([key, bucket]) => ({
        assistant_calls: bucket.assistant_calls,
        key,
        label: key,
        usage: bucket.usage
      })),
    files_missing: filesMissing,
    generated_at: now.toISOString(),
    project_usage: [...projects.entries()]
      .map(([projectID, project]) => ({ project_id: projectID, ...project }))
      .sort((left, right) => right.usage.total_tokens - left.usage.total_tokens ||
        left.project_id.localeCompare(right.project_id)),
    sessions_scanned: sessionsScanned,
    source: "pi_conversations.session_file",
    status: "available",
    summary
  };
}

async function readSessionUsage(path: string): Promise<CachedSessionUsage | undefined> {
  if (path.trim() === "") return undefined;
  let metadata;
  try {
    metadata = await stat(path);
  } catch {
    return undefined;
  }
  if (!metadata.isFile()) return undefined;
  const cached = sessionUsageCache.get(path);
  if (cached && cached.size === metadata.size && cached.mtime_ms === metadata.mtimeMs) return cached;
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch {
    return undefined;
  }
  const days = new Map<string, { assistant_calls: number; usage: PiUsage }>();
  let corruptLines = 0;
  for (const line of content.split("\n")) {
    if (line.trim() === "") continue;
    const record = parseRecord(line);
    if (!record) {
      corruptLines += 1;
      continue;
    }
    const usage = assistantMessageUsage(record);
    if (!usage) continue;
    const timestamp = new Date(text(record.timestamp));
    if (Number.isNaN(timestamp.getTime())) {
      corruptLines += 1;
      continue;
    }
    const key = dayKey(timestamp);
    const bucket = days.get(key) ?? { assistant_calls: 0, usage: zeroPiUsage() };
    bucket.assistant_calls += 1;
    addPiUsage(bucket.usage, usage);
    days.set(key, bucket);
  }
  const result = {
    corrupt_lines: corruptLines,
    days: [...days.entries()].map(([key, bucket]) => ({ key, ...bucket })),
    mtime_ms: metadata.mtimeMs,
    size: metadata.size
  };
  sessionUsageCache.set(path, result);
  return result;
}

function assistantMessageUsage(record: Record<string, unknown>): PiUsage | undefined {
  if (record.type !== "message") return undefined;
  const message = objectValue(record.message);
  if (message.role !== "assistant") return undefined;
  const usage = objectValue(message.usage);
  if (Object.keys(usage).length === 0) return undefined;
  const uncached = tokenNumber(usage.input ?? usage.input_tokens);
  const cached = tokenNumber(usage.cacheRead ?? usage.cache_read_input_tokens);
  const cacheWrite = tokenNumber(usage.cacheWrite ?? usage.cache_creation_input_tokens);
  const output = tokenNumber(usage.output ?? usage.output_tokens);
  const calculated = uncached + cached + cacheWrite + output;
  const reported = tokenNumber(usage.totalTokens ?? usage.total_tokens);
  return {
    cached_input_tokens: cached,
    cache_write_input_tokens: cacheWrite,
    input_tokens: uncached + cached + cacheWrite,
    output_tokens: output,
    reasoning_output_tokens: 0,
    total_tokens: reported > 0 ? reported : calculated,
    uncached_input_tokens: uncached
  };
}

function uniqueSessions(sessions: PiUsageSessionRef[]): PiUsageSessionRef[] {
  const byFile = new Map<string, PiUsageSessionRef>();
  for (const session of sessions) {
    const file = session.session_file.trim();
    if (file !== "") byFile.set(file, { ...session, session_file: file });
  }
  return [...byFile.values()];
}

function mapBucket(values: Map<string, PiUsageBucket>, key: string): PiUsageBucket {
  const current = values.get(key) ?? { assistant_calls: 0, usage: zeroPiUsage() };
  values.set(key, current);
  return current;
}

function mapProjectUsage(
  values: Map<string, { assistant_calls: number; sessions: number; usage: PiUsage }>,
  projectID: string
) {
  const key = projectID.trim() || "runner-global";
  const current = values.get(key) ?? { assistant_calls: 0, sessions: 0, usage: zeroPiUsage() };
  values.set(key, current);
  return current;
}

function aggregateMatching(daily: Map<string, PiUsageBucket>, matches: (key: string) => boolean): PiUsage {
  return aggregateBuckets([...daily.entries()].filter(([key]) => matches(key)).map(([, bucket]) => bucket));
}

function aggregateBuckets(buckets: Iterable<PiUsageBucket>): PiUsage {
  const usage = zeroPiUsage();
  for (const bucket of buckets) addPiUsage(usage, bucket.usage);
  return usage;
}

function zeroPiUsage(): PiUsage {
  return {
    ...zeroUsage(),
    cache_write_input_tokens: 0,
    uncached_input_tokens: 0
  };
}

function addPiUsage(target: PiUsage, usage: PiUsage): void {
  addUsage(target, usage);
  target.cache_write_input_tokens += usage.cache_write_input_tokens;
  target.uncached_input_tokens += usage.uncached_input_tokens;
}

function parseRecord(line: string): Record<string, unknown> | undefined {
  try {
    return objectValue(JSON.parse(line));
  } catch {
    return undefined;
  }
}

function objectValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function tokenNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function workerEnvironment(): Record<string, string> {
  return Object.fromEntries(["HOME", "PATH", "TMPDIR", "TZ"]
    .map((key) => [key, Bun.env[key] ?? ""])
    .filter(([, value]) => value !== ""));
}
