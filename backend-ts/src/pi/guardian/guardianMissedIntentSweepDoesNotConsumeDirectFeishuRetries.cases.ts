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

export function registerDoesNotConsumeDirectFeishuRetries() {
test("does not consume direct Feishu retries for a PI-owned missed digest", async () => {
    const db = await openFixtureDatabase();
    const sender = new FakeGuardianSender([new Error("temporary Feishu outage")]);
    insertProject(db, "demo");
    insertOutageAlert(db, "outbox_stalled");
    insertMissedIntent(db, "intent-pending-failed", { issueID: 906, kind: "issue_done", state: "ready" });

    const result = runGuardianMissedIntentSweepOnce(db, {
      now: NOW,
      watchdog: unavailableDigestWatchdog()
    });
    await sendMissedDigestPendingFallback(db, result.pendingAlertIds, guardianDelivery(db, sender, new Date(NOW)));
    const alert = getPiGuardianAlert(db, result.pendingAlertIds[0] ?? "");

    expect(sender.calls).toHaveLength(0);
    expect(alert).toMatchObject({
      direct_feishu_error: "",
      direct_feishu_state: "not_attempted",
      next_retry_at: "",
      retry_count: 0,
      status: "open",
      ui_visible: 1
    });
  });
}
