import { describe } from "bun:test";
import { createTestFixture } from "./feishuPiActionCards.testFixture.ts";
import { registerDispatchesPendingPiActionNotificationsCases } from "./feishuPiActionCards.cases-dispatches-pending-pi-action-notifications.ts";
import { registerRejectsPiActionCallbacksFromCases } from "./feishuPiActionCards.cases-rejects-pi-action-callbacks-from.ts";

const fixture = createTestFixture();

describe("Feishu PI action cards", () => {
  registerDispatchesPendingPiActionNotificationsCases(fixture);
  registerRejectsPiActionCallbacksFromCases(fixture);
});
