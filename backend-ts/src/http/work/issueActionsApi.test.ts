import { describe } from "bun:test";
import { createTestFixture } from "./issueActionsApi.testFixture.ts";
import { registerEnqueueQueuesIdleIssuesAndCases } from "./issueActionsApi.cases-enqueue-queues-idle-issues-and.ts";
import { registerLetsAManagedExecutorControlCases } from "./issueActionsApi.cases-lets-a-managed-executor-control.ts";

const fixture = createTestFixture();

describe("Bun issue action API", () => {
  registerEnqueueQueuesIdleIssuesAndCases(fixture);
  registerLetsAManagedExecutorControlCases(fixture);
});
