import { describe } from "bun:test";
import { createTestFixture } from "./feishuEventsApi.testFixture.ts";
import { registerRespondsToUrlVerificationChallengeCases } from "./feishuEventsApi.cases-responds-to-url-verification-challenge.ts";
import { registerRejectsInvalidSignaturesBeforeAcceptingCases } from "./feishuEventsApi.cases-rejects-invalid-signatures-before-accepting.ts";

const fixture = createTestFixture();

describe("Feishu events endpoint", () => {
  registerRespondsToUrlVerificationChallengeCases(fixture);
  registerRejectsInvalidSignaturesBeforeAcceptingCases(fixture);
});
