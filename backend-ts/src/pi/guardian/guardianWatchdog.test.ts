import { describe, expect, test } from "bun:test";
import { type RunnerDatabase } from "../../db/database.ts";
import {
  createPiNotificationIntent,
  getPiGuardianWatchdogStatus,
  listPiGuardianAlerts,
  listPiNotificationIntents,
  upsertPiGuardianWatchdogStatus
} from "../../db/repositories/pi.ts";
import { buildFeishuConnectorConfig } from "../../integrations/feishu/feishu.ts";
import { FeishuClientError } from "../../integrations/feishu/feishuClient.ts";
import { sendDirectFeishuGuardianAlert } from "../../integrations/feishu/feishuGuardianAlerts.ts";
import { runPiGuardianWatchdogOnce } from "./guardianWatchdog.ts";
import { useTestDatabase } from "../../testing/harness.ts";

import { openFixtureDatabase, NOW, STALE_MS, insertProject, failingProbe, feishuConfig, guardianDelivery, FakeGuardianFeishuSender, insertProjectPiSettings, insertStuckOutbox, insertSuppressedStuckOutbox, insertStaleNotificationIntent, insertUnroutableLifecycleIntent, insertOverdueRunGroup, insertFailedApprovalResolver, insertPendingGuardianInboxEvent, markAlertStatus, sideEffectCounts, countRows } from "./guardianWatchdogTestFixtures.ts";
import { registerDetectsOldReadyDigestsWithoutActive } from "./guardianWatchdogDetectsOldReadyDigestsWithoutActive.cases.ts";
import { registerRetriesUnacknowledgedSentUrgentAlertsWith } from "./guardianWatchdogRetriesUnacknowledgedSentUrgentAlertsWith.cases.ts";
import { registerIgnoresUnroutableLifecycleIntentsWhenChecking } from "./guardianWatchdogIgnoresUnroutableLifecycleIntentsWhenChecking.cases.ts";



describe("PI Guardian watchdog detector", () => {
  registerDetectsOldReadyDigestsWithoutActive();
  registerRetriesUnacknowledgedSentUrgentAlertsWith();
  registerIgnoresUnroutableLifecycleIntentsWhenChecking();
});
