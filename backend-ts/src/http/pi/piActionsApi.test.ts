import { describe } from "bun:test";
import { createTestFixture } from "./piActionsApi.testFixture.ts";
import { registerListsPendingActionsAndPublishesCases } from "./piActionsApi.cases-lists-pending-actions-and-publishes.ts";
import { registerExecuteRejectsAnApprovedActionCases } from "./piActionsApi.cases-execute-rejects-an-approved-action.ts";

const fixture = createTestFixture();

describe("Bun PI actions API", () => {
  registerListsPendingActionsAndPublishesCases(fixture);
  registerExecuteRejectsAnApprovedActionCases(fixture);
});
