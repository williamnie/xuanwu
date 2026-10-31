import { describe } from "bun:test";
import { createTestFixture } from "./feishuAgentBridge.testFixture.ts";
import { registerAddsAQuickFeishuReactionCases } from "./feishuAgentBridge.cases-adds-a-quick-feishu-reaction.ts";
import { registerRoutesTrustedCapabilityQuestionsToCases } from "./feishuAgentBridge.cases-routes-trusted-capability-questions-to.ts";
import { registerReportsRunnerErrorsAsACases } from "./feishuAgentBridge.cases-reports-runner-errors-as-a.ts";

const fixture = createTestFixture();

describe("Feishu agent bridge", () => {
  registerAddsAQuickFeishuReactionCases(fixture);
  registerRoutesTrustedCapabilityQuestionsToCases(fixture);
  registerReportsRunnerErrorsAsACases(fixture);
});
