import { describe } from "bun:test";
import { createTestFixture } from "./feishuInboxApi.testFixture.ts";
import { registerRunsLocalFeishuSmokeFromCases } from "./feishuInboxApi.cases-runs-local-feishu-smoke-from.ts";

const fixture = createTestFixture();

describe("Feishu external event inbox", () => {
  registerRunsLocalFeishuSmokeFromCases(fixture);
});
