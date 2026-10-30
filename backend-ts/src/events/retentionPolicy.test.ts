import { describe } from "bun:test";
import { registerRetentionPolicyClassificationCases } from "./retentionPolicyClassificationCases.ts";
import { registerRetentionPolicyDeletionGatesCases } from "./retentionPolicyDeletionGatesCases.ts";

describe("event retention policy", () => {
  registerRetentionPolicyClassificationCases();
  registerRetentionPolicyDeletionGatesCases();
});
