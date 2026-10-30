import { describe } from "bun:test";
import { createTestFixture } from "./sessionApi.testFixture.ts";
import { registerMetadataOnlyPreservesIndexedProviderCases } from "./sessionApi.cases-metadata-only-preserves-indexed-provider.ts";
import { registerReadsAnIndexedPiSessionCases } from "./sessionApi.cases-reads-an-indexed-pi-session.ts";
import { registerFailsClosedWhenAMigratedCases } from "./sessionApi.cases-fails-closed-when-a-migrated.ts";

const fixture = createTestFixture();

describe("Bun Sessions API compatibility", () => {
  registerMetadataOnlyPreservesIndexedProviderCases(fixture);
  registerReadsAnIndexedPiSessionCases(fixture);
  registerFailsClosedWhenAMigratedCases(fixture);
});
