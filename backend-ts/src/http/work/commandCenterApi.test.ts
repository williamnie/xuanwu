import { describe } from "bun:test";
import { createTestFixture } from "./commandCenterApi.testFixture.ts";
import { registerReturnsTheVersionedFourSectionCases } from "./commandCenterApi.cases-returns-the-versioned-four-section.ts";
import { registerShowsOnlyUserOwnedIncidentsCases } from "./commandCenterApi.cases-shows-only-user-owned-incidents.ts";
import { registerKeepsTheActiveWorkPartitionCases } from "./commandCenterApi.cases-keeps-the-active-work-partition.ts";

const fixture = createTestFixture();

describe("Command Center aggregate API", () => {
  registerReturnsTheVersionedFourSectionCases(fixture);
  registerShowsOnlyUserOwnedIncidentsCases(fixture);
  registerKeepsTheActiveWorkPartitionCases(fixture);
});
