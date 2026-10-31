import { cleanString } from "../../util/values.ts";
import { type RecentSupervisorEvent } from "./issueSupervisorContextSupport.ts";

export function gitStatusSummary(cwd: string): { hash: string; summary: string } {
  try {
    const proc = Bun.spawnSync(["git", "-C", cwd, "status", "--short"], { stdout: "pipe", stderr: "pipe" });
    if (proc.exitCode !== 0) return { hash: "", summary: "unknown" };
    const text = new TextDecoder().decode(proc.stdout).trim();
    return { hash: hashText(text), summary: text === "" ? "clean" : `${text.split("\n").length} changed paths` };
  } catch {
    return { hash: "", summary: "unknown" };
  }
}

export function parsePayload(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value) as unknown; } catch { return value; }
}

export function jsonArray(value: string): string[] {
  const parsed = parsePayload(value);
  return Array.isArray(parsed) ? parsed.map(String) : [];
}

export function lastSummary(events: RecentSupervisorEvent[], marker: string): string {
  return events.filter((event) => event.markers.includes(marker)).at(-1)?.summary ?? "";
}

export function ageSeconds(value: string, now: Date): number {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, Math.round((now.getTime() - timestamp) / 1_000)) : 0;
}

export function truncate(value: string): string {
  return value.length <= 260 ? value : `${value.slice(0, 259)}…`;
}

export function hashText(value: string): string {
  let hash = 0;
  for (const char of value) hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0;
  return value === "" ? "" : String(hash >>> 0);
}

export function timeMs(value: string | undefined): number | undefined {
  const ms = Date.parse(cleanString(value));
  return Number.isFinite(ms) ? ms : undefined;
}

export function iso(value: number): string {
  return new Date(value).toISOString().replace(/\.\d{3}Z$/, "Z");
}
