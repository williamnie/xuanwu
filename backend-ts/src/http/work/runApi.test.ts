import { describe } from "bun:test";
import { createTestFixture } from "./runApi.testFixture.ts";
import { registerBuildsABoundedSlowListCases } from "./runApi.cases-builds-a-bounded-slow-list.ts";
import { registerRequiresBearerAuthAndPerformsCases } from "./runApi.cases-requires-bearer-auth-and-performs.ts";

const fixture = createTestFixture();

describe("Run HTTP API", () => {
  registerBuildsABoundedSlowListCases(fixture);
  registerRequiresBearerAuthAndPerformsCases(fixture);
});
