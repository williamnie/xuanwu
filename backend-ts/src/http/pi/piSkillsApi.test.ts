import { describe } from "bun:test";
import { createTestFixture } from "./piSkillsApi.testFixture.ts";
import { registerListsSkillsWithDiagnosticsAndCases } from "./piSkillsApi.cases-lists-skills-with-diagnostics-and.ts";
import { registerListsIntakeAndDomainRunsCases } from "./piSkillsApi.cases-lists-intake-and-domain-runs.ts";

const fixture = createTestFixture();

describe("PI skill metadata API", () => {
  registerListsSkillsWithDiagnosticsAndCases(fixture);
  registerListsIntakeAndDomainRunsCases(fixture);
});
