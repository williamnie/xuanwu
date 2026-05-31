import type { RunnerDatabase } from "../database.ts";
import { issueTimestamp } from "./issueCreate.ts";

export type NotificationSettings = { active_end: string; active_start: string; events: string[]; webhook_url: string };
const KEY = "notifications.settings";

export function getNotificationSettings(db: RunnerDatabase): NotificationSettings {
  const row = db.sqlite.query<{ value: string }, [string]>("select value from app_preferences where key=?").get(KEY);
  if (!row?.value) return defaultSettings();
  return normalizeSettings(JSON.parse(row.value));
}

export function saveNotificationSettings(db: RunnerDatabase, input: unknown): NotificationSettings {
  const settings = normalizeSettings(input);
  db.sqlite.run(`insert into app_preferences (key, value, updated_at) values (?, ?, ?)
    on conflict(key) do update set value=excluded.value, updated_at=excluded.updated_at`,
    [KEY, JSON.stringify(settings), issueTimestamp()]);
  return settings;
}

function defaultSettings(): NotificationSettings {
  return { webhook_url: "", events: ["done", "failed"], active_start: "", active_end: "" };
}

function normalizeSettings(input: unknown): NotificationSettings {
  const raw = typeof input === "object" && input !== null && !Array.isArray(input) ? input as Record<string, unknown> : {};
  const settings = {
    webhook_url: cleanString(raw.webhook_url), events: normalizeEvents(raw.events),
    active_start: cleanString(raw.active_start), active_end: cleanString(raw.active_end)
  };
  validateClockPair(settings.active_start, settings.active_end);
  return settings;
}

function normalizeEvents(value: unknown): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const event of Array.isArray(value) ? value : []) {
    const clean = cleanString(event);
    if ((clean === "done" || clean === "failed") && !seen.has(clean)) { seen.add(clean); out.push(clean); }
  }
  return out;
}

function validateClockPair(start: string, end: string): void {
  if (start === "" && end === "") return;
  if (start === "" || end === "") throw new Error("active_start 和 active_end 必须同时设置");
  if (!validClock(start) || !validClock(end)) throw new Error("通知时间段必须使用 HH:MM 格式");
}

function validClock(value: string): boolean { return /^([01]\d|2[0-3]):[0-5]\d$/.test(value); }
function cleanString(value: unknown): string { return typeof value === "string" ? value.trim() : ""; }
