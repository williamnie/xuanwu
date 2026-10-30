import { describe } from "bun:test";
import { createTestFixture } from "./piActionProposalsApi.testFixture.ts";
import { registerPersistsDomainSkillMultiActionCases } from "./piActionProposalsApi.cases-persists-domain-skill-multi-action.ts";
import { registerApprovedReplySendQueuesOutboxCases } from "./piActionProposalsApi.cases-approved-reply-send-queues-outbox.ts";

const fixture = createTestFixture();

describe("PI action proposals API", () => {
  registerPersistsDomainSkillMultiActionCases(fixture);
  registerApprovedReplySendQueuesOutboxCases(fixture);
});
