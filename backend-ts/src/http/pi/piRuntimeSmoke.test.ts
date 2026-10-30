import { describe } from "bun:test";
import { createTestFixture } from "./piRuntimeSmoke.testFixture.ts";
import { registerKeepsPersonaFinalInControlledCases } from "./piRuntimeSmoke.cases-keeps-persona-final-in-controlled.ts";
import { registerAssemblesPiRuntimeToolsFromCases } from "./piRuntimeSmoke.cases-assembles-pi-runtime-tools-from.ts";
import { registerRollsAnOverBudgetImCases } from "./piRuntimeSmoke.cases-rolls-an-over-budget-im.ts";
import { registerInjectsOnlyAuthorizedSkillMetadataCases } from "./piRuntimeSmoke.cases-injects-only-authorized-skill-metadata.ts";

const fixture = createTestFixture();

describe("Bun PI runtime v1 smoke", () => {
  registerKeepsPersonaFinalInControlledCases(fixture);
  registerAssemblesPiRuntimeToolsFromCases(fixture);
  registerRollsAnOverBudgetImCases(fixture);
  registerInjectsOnlyAuthorizedSkillMetadataCases(fixture);
});
