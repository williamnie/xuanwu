import { describe } from "bun:test";
import { createTestFixture } from "./piToolRegistryApi.testFixture.ts";
import { registerReturnsBuiltinProvidersAndToolCases } from "./piToolRegistryApi.cases-returns-builtin-providers-and-tool.ts";
import { registerRedactsSecretLookingValuesFromCases } from "./piToolRegistryApi.cases-redacts-secret-looking-values-from.ts";

const fixture = createTestFixture();

describe("PI tool registry read API", () => {
  registerReturnsBuiltinProvidersAndToolCases(fixture);
  registerRedactsSecretLookingValuesFromCases(fixture);
});
