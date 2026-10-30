import { describe } from "bun:test";
import { createTestFixture } from "./readApi.testFixture.ts";
import { registerExposesFrontendCompatibleProjectAndCases } from "./readApi.cases-exposes-frontend-compatible-project-and.ts";
import { registerCreatesIssuesWithDefaultTriageCases } from "./readApi.cases-creates-issues-with-default-triage.ts";

const fixture = createTestFixture();

describe("Bun projects/issues read API", () => {
  registerExposesFrontendCompatibleProjectAndCases(fixture);
  registerCreatesIssuesWithDefaultTriageCases(fixture);
});
