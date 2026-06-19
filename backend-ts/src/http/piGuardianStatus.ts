import type { RunnerDatabase } from "../db/database.ts";
import { getPiGuardianWatchdogStatus } from "../db/repositories/pi.ts";

export const PI_GUARDIAN_WATCHDOG_STALE_AFTER_MS = 120_000;

export function buildPiGuardianSystemStatus(
  database: RunnerDatabase,
  now: Date = new Date()
): Record<string, unknown> {
  const status = getPiGuardianWatchdogStatus(database);
  const lastSeen = status?.last_seen_at ?? "";
  return {
    watchdog: {
      is_stale: isWatchdogStale(lastSeen, now),
      last_seen: lastSeen,
      stale_after: staleAfter(lastSeen)
    }
  };
}

function isWatchdogStale(lastSeen: string, now: Date): boolean {
  const seenAt = Date.parse(lastSeen);
  if (!Number.isFinite(seenAt)) return true;
  return now.getTime() - seenAt > PI_GUARDIAN_WATCHDOG_STALE_AFTER_MS;
}

function staleAfter(lastSeen: string): string {
  const seenAt = Date.parse(lastSeen);
  if (!Number.isFinite(seenAt)) return "";
  return iso(new Date(seenAt + PI_GUARDIAN_WATCHDOG_STALE_AFTER_MS));
}

function iso(value: Date): string {
  return value.toISOString().replace(/\.\d{3}Z$/, "Z");
}
