import { describe } from "bun:test";
import { createTestFixture } from "./feishuNotifications.testFixture.ts";
import { registerFeedbackContinuationGetsItsOwnCases } from "./feishuNotifications.cases-feedback-continuation-gets-its-own.ts";
import { registerQueuesOneFeishuNeedsUserCases } from "./feishuNotifications.cases-queues-one-feishu-needs-user.ts";

const fixture = createTestFixture();

describe("Feishu notification queue", () => {
  registerFeedbackContinuationGetsItsOwnCases(fixture);
  registerQueuesOneFeishuNeedsUserCases(fixture);
});
