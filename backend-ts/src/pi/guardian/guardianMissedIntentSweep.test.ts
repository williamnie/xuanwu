import { describe, expect, test } from "bun:test";
import { type RunnerDatabase } from "../../db/database.ts";
import { listSyncOutbox } from "../../db/repositories/imReplyOutbox.ts";
import {
  createPiNotificationIntent,
  getPiGuardianAlert,
  listPiGuardianAlerts,
  listPiGuardianDecisions,
  listPiNotificationIntents,
  upsertPiGuardianAlert
} from "../../db/repositories/pi.ts";
import { buildFeishuConnectorConfig } from "../../integrations/feishu/feishu.ts";
import type { FeishuTextMessageInput, FeishuTextMessageResult } from "../../integrations/feishu/feishuClient.ts";
import { sendDirectFeishuGuardianAlert } from "../../integrations/feishu/feishuGuardianAlerts.ts";
import { sendMissedDigestPendingFallback } from "./guardianMissedDigestFallback.ts";
import { runGuardianMissedIntentSweepOnce } from "./guardianMissedIntentSweep.ts";
import { resolveRecoveredAlerts } from "./guardianWatchdogMaintenance.ts";
import type { PiGuardianWatchdogComponent } from "./guardianWatchdog.ts";
import type { PiGuardianWatchdogSummary } from "./guardianWatchdog.ts";
import { useTestDatabase } from "../../testing/harness.ts";

import { openFixtureDatabase, NOW, insertProject, insertOutageAlert, insertMissedIntent, recoveryDigests, recoveredWatchdog, unavailableDigestWatchdog, defaultFeishuConfig, guardianDelivery, FakeGuardianSender } from "./guardianMissedIntentSweepTestFixtures.ts";
import { registerARecoveryDigestCarriesTheVerified } from "./guardianMissedIntentSweepARecoveryDigestCarriesTheVerified.cases.ts";
import { registerDoesNotConsumeDirectFeishuRetries } from "./guardianMissedIntentSweepDoesNotConsumeDirectFeishuRetries.cases.ts";



describe("PI Guardian missed intent sweep", () => {
  registerARecoveryDigestCarriesTheVerified();
  registerDoesNotConsumeDirectFeishuRetries();
});
