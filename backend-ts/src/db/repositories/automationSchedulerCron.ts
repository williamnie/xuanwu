import type { VersionedAutomationTrigger } from "../../domain/automation/contracts.ts";

export function nextRunAfter(trigger: VersionedAutomationTrigger, after: Date): string | null {
  if (trigger.type === "continuous") {
    return new Date(after.getTime() + trigger.config.poll_interval_seconds * 1000).toISOString();
  }
  if (trigger.type === "cron") return nextCronOccurrence(trigger.config.expression, trigger.config.timezone, after)?.toISOString() ?? null;
  return null;
}

export function nextCronOccurrence(expression: string, timezone: string, after: Date): Date | null {
  const fields = cronFields(expression);
  const start = new Date(Math.floor(after.getTime() / 60_000) * 60_000 + 60_000);
  const previousLocal = localSlot(after, timezone);
  for (let offset = 0; offset <= 366 * 24 * 60; offset += 1) {
    const candidate = new Date(start.getTime() + offset * 60_000);
    const parts = zonedParts(candidate, timezone);
    if (matchesCron(fields, parts) && localSlot(candidate, timezone) !== previousLocal) return candidate;
  }
  return null;
}

type CronFields = { day: Set<number> | null; hour: Set<number> | null; minute: Set<number> | null; month: Set<number> | null; weekday: Set<number> | null };

type ZonedParts = { day: number; hour: number; minute: number; month: number; weekday: number; year: number };

function cronFields(expression: string): CronFields {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error("cron expression must have five fields");
  return {
    minute: cronField(fields[0], 0, 59), hour: cronField(fields[1], 0, 23), day: cronField(fields[2], 1, 31),
    month: cronField(fields[3], 1, 12), weekday: cronField(fields[4], 0, 6, true)
  };
}

function cronField(text: string, min: number, max: number, sundaySeven = false): Set<number> | null {
  if (text === "*") return null;
  const values = new Set<number>();
  for (const part of text.split(",")) {
    const [range, stepText] = part.split("/");
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isSafeInteger(step) || step < 1) throw new Error("cron step is invalid");
    const [fromText, toText] = range === "*" ? [String(min), String(max)] : range.split("-");
    const from = cronNumber(fromText, min, max, sundaySeven);
    const to = cronNumber(toText ?? fromText, min, max, sundaySeven);
    if (from > to) throw new Error("cron range is invalid");
    for (let value = from; value <= to; value += step) values.add(value);
  }
  return values;
}

function cronNumber(text: string, min: number, max: number, sundaySeven: boolean): number {
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value < min || value > (sundaySeven ? 7 : max)) throw new Error("cron field is invalid");
  return sundaySeven && value === 7 ? 0 : value;
}

function matchesCron(fields: CronFields, parts: ZonedParts): boolean {
  return matches(fields.minute, parts.minute) && matches(fields.hour, parts.hour) && matches(fields.day, parts.day)
    && matches(fields.month, parts.month) && matches(fields.weekday, parts.weekday);
}

function matches(values: Set<number> | null, value: number): boolean { return values === null || values.has(value); }

function zonedParts(date: Date, timezone: string): ZonedParts {
  const values = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    day: "2-digit", hour: "2-digit", hourCycle: "h23", minute: "2-digit", month: "2-digit",
    timeZone: timezone, weekday: "short", year: "numeric"
  }).formatToParts(date).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return {
    day: Number(values.day), hour: Number(values.hour), minute: Number(values.minute), month: Number(values.month),
    weekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(values.weekday), year: Number(values.year)
  };
}

function localSlot(date: Date, timezone: string): string {
  const parts = zonedParts(date, timezone);
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}
