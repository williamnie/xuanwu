import { describe } from "bun:test";
import { createTestFixture } from "./piMemoryApi.testFixture.ts";
import { registerDiagnosticsRequireHttpAuthenticationAndCases } from "./piMemoryApi.cases-diagnostics-require-http-authentication-and.ts";
import { registerCreatesActiveMemoryAndUpdatesCases } from "./piMemoryApi.cases-creates-active-memory-and-updates.ts";

const fixture = createTestFixture();

describe("Bun PI reusable memory API", () => {
  registerDiagnosticsRequireHttpAuthenticationAndCases(fixture);
  registerCreatesActiveMemoryAndUpdatesCases(fixture);
});
