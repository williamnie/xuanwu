import { sendMissedDigestPendingFallback } from "../pi/guardian/guardianMissedDigestFallback.ts";
import type { GuardianAlertDelivery } from "../pi/guardian/guardianAlertDelivery.ts";
import { runGuardianMissedIntentSweepOnce, type GuardianMissedIntentSweepResult } from "../pi/guardian/guardianMissedIntentSweep.ts";
import { type PiGuardianWatchdogSummary } from "../pi/guardian/guardianWatchdog.ts";
import type { ImChannelRegistry } from "../integrations/im/imChannelContracts.ts";
import { dispatchImOutbox } from "../pi/notifications/imReplyOutboxDispatcher.ts";
import type { PiAutoManageCycleInput } from "./piAutoManageScheduler.model.ts";

export async function runMissedIntentSweepWithFallback(
  input: PiAutoManageCycleInput,
  watchdog: PiGuardianWatchdogSummary,
  delivery: GuardianAlertDelivery | undefined
): Promise<GuardianMissedIntentSweepResult> {
  const result = runGuardianMissedIntentSweepOnce(input.database, {
    fallbackConnectorID: singleImConnectorID(input.imChannels),
    now: input.watchdogNow,
    watchdog
  });
  await sendMissedDigestPendingFallback(input.database, result.pendingAlertIds, delivery);
  return result;
}

export function singleImConnectorID(registry: ImChannelRegistry | undefined): string {
  const ids = registry?.list().map((module) => module.id) ?? [];
  return ids.length === 1 ? ids[0]! : "";
}

export function dispatchSchedulerImOutbox(input: PiAutoManageCycleInput) {
  if (!input.imChannels) throw new Error("im channel registry is not configured");
  return dispatchImOutbox({
    database: input.database,
    now: optionalDate(input.watchdogNow),
    resolveConnector: (source) => input.imChannels!.get(source).connector
  });
}

export function optionalDate(value: Date | string | undefined): Date | undefined {
  if (value instanceof Date) return value;
  return typeof value === "string" && value.trim() !== "" ? new Date(value) : undefined;
}

export function cycleNowText(value: Date | string | undefined): string {
  if (value instanceof Date) return value.toISOString().replace(/\.\d{3}Z$/, "Z");
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}
