export type ScheduleParseOptions = {
  base?: Date;
  timezone?: string;
};

export type ParsedSchedule = {
  mode: string; next_run_at: string; time_of_day: string; timezone: string; working_hours_json: string;
};

type CronLikeSchedule = {
  mode: string; next_run_at: string; quiet_hours_json?: string; time_of_day: string; timezone?: string; working_hours_json?: string;
};
type ZonedParts = {
  day: number; hour: number; minute: number; month: number; second: number; weekday: number; year: number;
};

const DEFAULT_TIMEZONE = "UTC";
const DEFAULT_SCHEDULE_TIMEZONE = "Asia/Shanghai";
const DEFAULT_WORKING_HOURS = "{}";
const WEEKDAY_POLICY = JSON.stringify({ after_hours_mode: "delegated", attended_hours: { end: "18:00", start: "09:00" }, weekdays: [1, 2, 3, 4, 5] });

export function parseScheduleExpression(expression: string, options: ScheduleParseOptions = {}): ParsedSchedule {
  const text = expression.trim();
  const timezone = cleanTimezone(options.timezone ?? DEFAULT_SCHEDULE_TIMEZONE);
  const base = options.base ?? new Date();
  if (/工作日.*下班后/.test(text)) return parsedDaily(base, timezone, "18:30", WEEKDAY_POLICY);
  const hour = parseHour(text);
  if (hour < 0) throw new Error("schedule expression unsupported");
  const time = `${String(hour).padStart(2, "0")}:00`;
  if (/每天|每日/.test(text)) return parsedDaily(base, timezone, time);
  if (/今晚|今天/.test(text)) {
    return {
      mode: "once",
      next_run_at: nextOnceRun(base, timezone, hour, 0).toISOString(),
      time_of_day: time,
      timezone,
      working_hours_json: DEFAULT_WORKING_HOURS
    };
  }
  throw new Error("schedule expression unsupported");
}

export function nextRunAfter(task: CronLikeSchedule, now: Date): string {
  const mode = task.mode.trim();
  if (mode === "once") return "";
  const timezone = cleanTimezone(task.timezone);
  const base = validDate(task.next_run_at) ?? now;
  const parts = zonedParts(base, timezone);
  const time = parseTimeOfDay(task.time_of_day, parts.hour, parts.minute);
  const nextParts = advanceCandidateParts(mode, { ...parts, hour: time.hour, minute: time.minute, second: 0 }, timezone, now);
  return normalizeCandidate(nextParts, timezone, workingDays(task.working_hours_json), now).toISOString();
}

export function scheduleRunMode(task: CronLikeSchedule, now: Date): "attended" | "delegated" {
  const policy = parseObject(task.working_hours_json);
  if (policy.after_hours_mode !== undefined && policy.after_hours_mode !== "delegated") return "attended";
  if (policy.after_hours_mode !== "delegated" && !hasWorkingHoursPolicy(policy)) return "attended";
  const timezone = cleanTimezone(task.timezone);
  const parts = zonedParts(now, timezone);
  const weekdays = numberArray(policy.weekdays);
  if (weekdays.length > 0 && !weekdays.includes(parts.weekday)) return "attended";
  const attended = parseAttendedHours(policy.attended_hours ?? policy);
  const minutes = parts.hour * 60 + parts.minute;
  return minutes < attended.start || minutes >= attended.end ? "delegated" : "attended";
}

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

function parsedDaily(base: Date, timezone: string, time: string, workingHours = DEFAULT_WORKING_HOURS): ParsedSchedule {
  return {
    mode: "daily",
    next_run_at: nextDailyRun(time, base, timezone, workingHours).toISOString(),
    time_of_day: time,
    timezone,
    working_hours_json: workingHours
  };
}

function nextOnceRun(base: Date, timezone: string, hour: number, minute: number): Date {
  let candidate = zonedTimeToUtc(todayParts(base, timezone, hour, minute), timezone);
  if (candidate.getTime() <= base.getTime()) candidate = addZonedDays(candidate, 1, timezone, { hour, minute });
  return candidate;
}

function nextDailyRun(time: string, base: Date, timezone: string, workingHours: string): Date {
  const parts = zonedParts(base, timezone);
  const parsed = parseTimeOfDay(time, parts.hour, parts.minute);
  let candidate = zonedTimeToUtc({ ...parts, hour: parsed.hour, minute: parsed.minute, second: 0 }, timezone);
  if (candidate.getTime() <= base.getTime()) candidate = addZonedDays(candidate, 1, timezone, parsed);
  return normalizeCandidate(zonedParts(candidate, timezone), timezone, workingDays(workingHours), base);
}

function normalizeCandidate(parts: ZonedParts, timezone: string, weekdays: number[], now: Date): Date {
  let candidate = zonedTimeToUtc(parts, timezone);
  for (let i = 0; i < 370 && candidate.getTime() <= now.getTime(); i += 1) {
    candidate = addZonedDays(candidate, 1, timezone, { hour: parts.hour, minute: parts.minute });
  }
  for (let i = 0; i < 8 && weekdays.length > 0 && !weekdays.includes(zonedParts(candidate, timezone).weekday); i += 1) {
    candidate = addZonedDays(candidate, 1, timezone, { hour: parts.hour, minute: parts.minute });
  }
  if (candidate.getTime() <= now.getTime()) return addZonedDays(candidate, 1, timezone, { hour: parts.hour, minute: parts.minute });
  return candidate;
}

function advanceCandidateParts(mode: string, parts: ZonedParts, timezone: string, now: Date): ZonedParts {
  let periods = 1;
  let candidate = advanceParts(mode, parts, periods);
  for (let i = 0; i < 370 && zonedTimeToUtc(candidate, timezone).getTime() <= now.getTime(); i += 1) {
    periods += 1;
    candidate = advanceParts(mode, parts, periods);
  }
  return candidate;
}

function advanceParts(mode: string, parts: ZonedParts, periods = 1): ZonedParts {
  if (mode === "daily") return addDaysToParts(parts, periods);
  if (mode === "weekly") return addDaysToParts(parts, periods * 7);
  if (mode === "monthly") return addMonthsToParts(parts, periods);
  throw new Error(`unsupported schedule mode ${mode}`);
}

function addDaysToParts(parts: ZonedParts, days: number): ZonedParts {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days, parts.hour, parts.minute, 0));
  return utcParts(date);
}

function addMonthsToParts(parts: ZonedParts, months: number): ZonedParts {
  const lastDay = daysInMonth(parts.year, parts.month + months);
  return { ...parts, day: Math.min(parts.day, lastDay), month: wrapMonth(parts.month + months), year: shiftedYear(parts.year, parts.month + months) };
}

function addZonedDays(date: Date, days: number, timezone: string, time: { hour: number; minute: number }): Date {
  const parts = addDaysToParts({ ...zonedParts(date, timezone), hour: time.hour, minute: time.minute, second: 0 }, days);
  return zonedTimeToUtc(parts, timezone);
}

function todayParts(base: Date, timezone: string, hour: number, minute: number): ZonedParts {
  return { ...zonedParts(base, timezone), hour, minute, second: 0 };
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

function parseHour(text: string): number {
  const match = text.match(/(\d{1,2})\s*[点:时]/);
  if (!match) return -1;
  let hour = Number(match[1]);
  if (hour < 12 && /(今晚|晚上|晚间|夜里|下午)/.test(text)) hour += 12;
  return Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : -1;
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

function workingDays(value: string | undefined): number[] {
  return numberArray(parseObject(value).weekdays);
}

function hasWorkingHoursPolicy(policy: Record<string, unknown>): boolean { return policy.start !== undefined || policy.end !== undefined || policy.attended_hours !== undefined || policy.weekdays !== undefined; }

function numberArray(value: unknown): number[] {
  return Array.isArray(value) ? value.filter((item): item is number => Number.isInteger(item)) : [];
}

function parseAttendedHours(value: unknown): { end: number; start: number } {
  const hours = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return { end: minutesOf(String(hours.end ?? "18:00")), start: minutesOf(String(hours.start ?? "09:00")) };
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

function validDate(value: string): Date | null {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(shiftedYear(year, month), wrapMonth(month), 0)).getUTCDate();
}

function shiftedYear(year: number, month: number): number {
  return year + Math.floor((month - 1) / 12);
}

function wrapMonth(month: number): number {
  return ((month - 1) % 12 + 12) % 12 + 1;
}

function weekdayNumber(value: string): number {
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(value);
}
