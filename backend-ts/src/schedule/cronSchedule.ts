type CronLikeSchedule = {
  mode: string; next_run_at: string; quiet_hours_json?: string; time_of_day: string; timezone?: string; working_hours_json?: string;
};
type ZonedParts = {
  day: number; hour: number; minute: number; month: number; second: number; weekday: number; year: number;
};

const DEFAULT_TIMEZONE = "UTC";
const WEEKDAY_POLICY = JSON.stringify({ after_hours_mode: "delegated", attended_hours: { end: "18:00", start: "09:00" }, weekdays: [1, 2, 3, 4, 5] });

export function quietHoursResumeAt(task: CronLikeSchedule, now: Date): string {
  const timezone = cleanTimezone(task.timezone);
  const parts = zonedParts(now, timezone);
  const minutes = parts.hour * 60 + parts.minute;
  for (const quiet of parseQuietHours(task.quiet_hours_json)) {
    if (!isInsideWindow(minutes, quiet.start, quiet.end)) continue;
    const end = splitMinutes(quiet.end);
    const dayOffset = quiet.start > quiet.end && minutes >= quiet.start ? 1 : 0;
    const target = addDaysToParts({ ...parts, hour: end.hour, minute: end.minute, second: 0 }, dayOffset);
    const resume = zonedTimeToUtc(target, timezone);
    return (resume.getTime() <= now.getTime() ? addZonedDays(resume, 1, timezone, end) : resume).toISOString();
  }
  return "";
}

function addDaysToParts(parts: ZonedParts, days: number): ZonedParts {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days, parts.hour, parts.minute, 0));
  return utcParts(date);
}

function addZonedDays(date: Date, days: number, timezone: string, time: { hour: number; minute: number }): Date {
  const parts = addDaysToParts({ ...zonedParts(date, timezone), hour: time.hour, minute: time.minute, second: 0 }, days);
  return zonedTimeToUtc(parts, timezone);
}

function zonedTimeToUtc(parts: ZonedParts, timezone: string): Date {
  let utc = new Date(Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second));
  for (let i = 0; i < 2; i += 1) {
    const actual = zonedParts(utc, timezone);
    const delta = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second)
      - Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, actual.second);
    utc = new Date(utc.getTime() + delta);
  }
  return utc;
}

function zonedParts(date: Date, timezone: string): ZonedParts {
  const values = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
    minute: "2-digit",
    month: "2-digit",
    second: "2-digit",
    timeZone: timezone,
    weekday: "short",
    year: "numeric"
  }).formatToParts(date).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return {
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
    month: Number(values.month),
    second: Number(values.second),
    weekday: weekdayNumber(values.weekday),
    year: Number(values.year)
  };
}

function utcParts(date: Date): ZonedParts {
  return {
    day: date.getUTCDate(),
    hour: date.getUTCHours(),
    minute: date.getUTCMinutes(),
    month: date.getUTCMonth() + 1,
    second: date.getUTCSeconds(),
    weekday: date.getUTCDay(),
    year: date.getUTCFullYear()
  };
}

function parseTimeOfDay(value: string, fallbackHour: number, fallbackMinute: number): { hour: number; minute: number } {
  const match = value.match(/^([01]\d|2[0-3]):([0-5]\d)$/);
  if (!match) return { hour: fallbackHour, minute: fallbackMinute };
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

function cleanTimezone(value: string | undefined): string {
  const timezone = value?.trim() || DEFAULT_TIMEZONE;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date());
    return timezone;
  } catch {
    throw new Error(`timezone unsupported: ${timezone}`);
  }
}

function parseQuietHours(value: unknown): Array<{ end: number; start: number }> {
  const quiet = parseObject(value);
  const windows = Array.isArray(quiet.daily) ? quiet.daily : [quiet];
  return windows.map(quietWindow).filter((item): item is { end: number; start: number } => item !== null);
}

function quietWindow(value: unknown): { end: number; start: number } | null {
  const input = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const startText = typeof input.start === "string" ? input.start : "";
  const endText = typeof input.end === "string" ? input.end : "";
  if (!isTime(startText) || !isTime(endText) || startText === endText) return null;
  return { end: minutesOf(endText), start: minutesOf(startText) };
}

function isInsideWindow(value: number, start: number, end: number): boolean {
  return start < end ? value >= start && value < end : value >= start || value < end;
}

function splitMinutes(value: number): { hour: number; minute: number } {
  return { hour: Math.floor(value / 60), minute: value % 60 };
}

function isTime(value: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

function minutesOf(value: string): number {
  const parsed = parseTimeOfDay(value, 0, 0);
  return parsed.hour * 60 + parsed.minute;
}

function parseObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "string" || value.trim() === "") return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function weekdayNumber(value: string): number {
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(value);
}
