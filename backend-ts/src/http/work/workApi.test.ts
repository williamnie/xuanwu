import { describe } from "bun:test";
import { createTestFixture } from "./workApi.testFixture.ts";
import { registerAtomicallyMaterializesStructuredDependenciesBeforeCases } from "./workApi.cases-atomically-materializes-structured-dependencies-before.ts";
import { registerReturnsStableErrorsForIllegalCases } from "./workApi.cases-returns-stable-errors-for-illegal.ts";

const fixture = createTestFixture();

describe("Work HTTP API", () => {
  registerAtomicallyMaterializesStructuredDependenciesBeforeCases(fixture);
  registerReturnsStableErrorsForIllegalCases(fixture);
});
