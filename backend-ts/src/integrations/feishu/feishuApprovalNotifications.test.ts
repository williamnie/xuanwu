import { describe } from "bun:test";
import { createTestFixture } from "./feishuApprovalNotifications.testFixture.ts";
import { registerRoutesACodexApprovalRequestCases } from "./feishuApprovalNotifications.cases-routes-a-codex-approval-request.ts";
import { registerObserverQueuesApprovalNotificationAndCases } from "./feishuApprovalNotifications.cases-observer-queues-approval-notification-and.ts";

const fixture = createTestFixture();

describe("Feishu approval notification queue", () => {
  registerRoutesACodexApprovalRequestCases(fixture);
  registerObserverQueuesApprovalNotificationAndCases(fixture);
});
