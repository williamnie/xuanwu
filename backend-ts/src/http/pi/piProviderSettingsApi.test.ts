import { describe } from "bun:test";
import { createTestFixture } from "./piProviderSettingsApi.testFixture.ts";
import { registerReturnsStableProviderPresetsAndCases } from "./piProviderSettingsApi.cases-returns-stable-provider-presets-and.ts";
import { registerOmitsAnEmptyBaseUrlCases } from "./piProviderSettingsApi.cases-omits-an-empty-base-url.ts";
import { registerReportsCodexOauthCredentialConnectionCases } from "./piProviderSettingsApi.cases-reports-codex-oauth-credential-connection.ts";

const fixture = createTestFixture();

describe("Bun PI provider settings API", () => {
  registerReturnsStableProviderPresetsAndCases(fixture);
  registerOmitsAnEmptyBaseUrlCases(fixture);
  registerReportsCodexOauthCredentialConnectionCases(fixture);
});
