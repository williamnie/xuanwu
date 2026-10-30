import { describe } from "bun:test";
import { createTestFixture } from "./evidenceApi.testFixture.ts";
import { registerPaginatesBoundedSummariesAndProvidesCases } from "./evidenceApi.cases-paginates-bounded-summaries-and-provides.ts";
import { registerWakesAnAutoRunProjectCases } from "./evidenceApi.cases-wakes-an-auto-run-project.ts";

const fixture = createTestFixture();

describe("Evidence HTTP API", () => {
  registerPaginatesBoundedSummariesAndProvidesCases(fixture);
  registerWakesAnAutoRunProjectCases(fixture);
});
