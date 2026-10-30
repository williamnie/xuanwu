import { describe } from "bun:test";
import { createTestFixture } from "./feishuReceiver.testFixture.ts";
import { registerStartsLongConnectionModeWithoutCases } from "./feishuReceiver.cases-starts-long-connection-mode-without.ts";
import { registerResolvesPiActionCardActionsCases } from "./feishuReceiver.cases-resolves-pi-action-card-actions.ts";

const fixture = createTestFixture();

describe("Feishu WebSocket receiver", () => {
  registerStartsLongConnectionModeWithoutCases(fixture);
  registerResolvesPiActionCardActionsCases(fixture);
});
