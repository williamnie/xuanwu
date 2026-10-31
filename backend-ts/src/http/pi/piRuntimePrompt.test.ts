import { describe } from "bun:test";
import { createTestFixture } from "./piRuntimePrompt.testFixture.ts";
import { registerIsolatesAllFiveExplicitProfilesCases } from "./piRuntimePrompt.cases-isolates-all-five-explicit-profiles.ts";
import { registerKeepsConfirmedProjectGlobalMemoryCases } from "./piRuntimePrompt.cases-keeps-confirmed-project-global-memory.ts";

const fixture = createTestFixture();

describe("Xuanwu PI runtime prompt", () => {
  registerIsolatesAllFiveExplicitProfilesCases(fixture);
  registerKeepsConfirmedProjectGlobalMemoryCases(fixture);
});
