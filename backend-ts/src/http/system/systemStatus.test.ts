import { describe } from "bun:test";
import { createTestFixture } from "./systemStatus.testFixture.ts";
import { registerReturnsPublicHealthPayloadCases } from "./systemStatus.cases-returns-public-health-payload.ts";
import { registerReportsPartiallyConfiguredFeishuConnectorCases } from "./systemStatus.cases-reports-partially-configured-feishu-connector.ts";
import { registerReportsConfiguredFeishuConnectorWithoutCases } from "./systemStatus.cases-reports-configured-feishu-connector-without.ts";
import { registerRegistryProviderApiStatusStatusCases } from "./systemStatus.cases-registry-provider-api-status-status.ts";

const fixture = createTestFixture();

describe("Bun system status endpoints", () => {
  registerReturnsPublicHealthPayloadCases(fixture);
  registerReportsPartiallyConfiguredFeishuConnectorCases(fixture);
  registerReportsConfiguredFeishuConnectorWithoutCases(fixture);
});

describe("P4: registry 投影接入 system status", () => {
  registerRegistryProviderApiStatusStatusCases(fixture);
});
