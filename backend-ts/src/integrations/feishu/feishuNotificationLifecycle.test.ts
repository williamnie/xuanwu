import { describe } from "bun:test";
import { createTestFixture } from "./feishuNotificationLifecycle.testFixture.ts";
import { registerRoutesAnIssueLifecycleNotificationCases } from "./feishuNotificationLifecycle.cases-routes-an-issue-lifecycle-notification.ts";
import { registerProjectLoopQueuesStartAndCases } from "./feishuNotificationLifecycle.cases-project-loop-queues-start-and.ts";

const fixture = createTestFixture();

describe("Feishu lifecycle notifications", () => {
  registerRoutesAnIssueLifecycleNotificationCases(fixture);
  registerProjectLoopQueuesStartAndCases(fixture);
});
