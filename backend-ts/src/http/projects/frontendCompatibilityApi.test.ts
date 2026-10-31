import { describe } from "bun:test";
import { createTestFixture } from "./frontendCompatibilityApi.testFixture.ts";
import { registerSyncsMissingLocalCodexWorkspaceCases } from "./frontendCompatibilityApi.cases-syncs-missing-local-codex-workspace.ts";
import { registerListsNotificationsAndMarksThemCases } from "./frontendCompatibilityApi.cases-lists-notifications-and-marks-them.ts";

const fixture = createTestFixture();

describe("Bun frontend API compatibility", () => {
  registerSyncsMissingLocalCodexWorkspaceCases(fixture);
  registerListsNotificationsAndMarksThemCases(fixture);
});
