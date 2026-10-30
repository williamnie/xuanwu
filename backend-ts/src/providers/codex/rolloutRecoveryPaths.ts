import { readdir } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ThreadSummary } from "./threadLifecycle.ts";
import { cleanString, objectValue } from "../../util/values.ts";

export async function resolveCodexRolloutPath(
  thread: ThreadSummary,
  roots: string[]
): Promise<string> {
  const explicit = cleanString(thread.path);
  if (safeCodexRolloutPath(explicit, roots)) return explicit;
  // thread/start 通常没有 rollout path；UUIDv7 自带时间，只查对应日期附近的受控 sessions 目录。
  const threadID = cleanString(thread.provider_session_id);
  const dateParts = uuidV7DateParts(threadID);
  if (dateParts.length === 0) return "";
  const suffix = `-${threadID}.jsonl`;
  for (const root of roots) {
    for (const parts of dateParts) {
      const directory = join(root, ...parts);
      let entries: Dirent[];
      try {
        entries = await readdir(directory, { withFileTypes: true });
      } catch {
        continue;
      }
      const matches = entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(suffix))
        .map((entry) => join(directory, entry.name))
        .sort();
      if (matches.length === 1 && safeCodexRolloutPath(matches[0]!, roots)) {
        return matches[0]!;
      }
    }
  }
  return "";
}

export function codexSessionRoots(codexHome?: string): string[] {
  const explicitHome = cleanString(codexHome);
  const configuredHome = explicitHome || cleanString(process.env.CODEX_HOME);
  const values = explicitHome
    ? [join(explicitHome, "sessions")]
    : [
      configuredHome ? join(configuredHome, "sessions") : "",
      join(homedir(), ".codex", "sessions")
    ];
  return [...new Set(values.filter(Boolean).map((root) => resolve(root)))];
}

export function safeCodexRolloutPath(path: string, roots: string[]): boolean {
  if (!isAbsolute(path)) return false;
  const candidate = resolve(path);
  return roots.some((root) => {
    const child = relative(root, candidate);
    return child !== "" && child !== ".." && !child.startsWith(`..${sep}`);
  });
}

export function uuidV7DateParts(threadID: string): string[][] {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(threadID)) {
    return [];
  }
  const timestamp = Number.parseInt(threadID.replaceAll("-", "").slice(0, 12), 16);
  if (!Number.isSafeInteger(timestamp)) return [];
  const output: string[][] = [];
  const seen = new Set<string>();
  for (const offset of [0, -86_400_000, 86_400_000]) {
    const date = new Date(timestamp + offset);
    const candidates = [
      [date.getFullYear(), date.getMonth() + 1, date.getDate()],
      [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()]
    ];
    for (const [year, month, day] of candidates) {
      const parts = [String(year), padDatePart(month), padDatePart(day)];
      const key = parts.join("/");
      if (seen.has(key)) continue;
      seen.add(key);
      output.push(parts);
    }
  }
  return output;
}

export function padDatePart(value: number): string {
  return String(value).padStart(2, "0");
}

export function elapsedMilliseconds(start: string, end: string): number {
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  return Number.isFinite(startMs) && Number.isFinite(endMs)
    ? Math.max(0, Math.round(endMs - startMs))
    : 0;
}

export function parsedObject(value: string): Record<string, unknown> | undefined {
  if (value.trim() === "") return undefined;
  try {
    return objectValue(JSON.parse(value));
  } catch {
    return undefined;
  }
}
