import { describe } from "bun:test";
import { createTestFixture } from "./feishuLifecycleNotifications.testFixture.ts";
import { registerLetsAgentConsolidateLegacyLifecycleCases } from "./feishuLifecycleNotifications.cases-lets-agent-consolidate-legacy-lifecycle.ts";
import { registerLegacyNoRunGroupSendCases } from "./feishuLifecycleNotifications.cases-legacy-no-run-group-send.ts";

const fixture = createTestFixture();

describe("Feishu lifecycle notification intents", () => {
  registerLetsAgentConsolidateLegacyLifecycleCases(fixture);
  registerLegacyNoRunGroupSendCases(fixture);
});
