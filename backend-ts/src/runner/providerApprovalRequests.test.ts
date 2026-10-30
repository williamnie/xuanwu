import { describe } from "bun:test";
import { registerProviderApprovalRequestsApprovalCases } from "./providerApprovalRequestsApprovalCases.ts";
import { registerProviderApprovalRequestsResolutionCases } from "./providerApprovalRequestsResolutionCases.ts";

describe("provider runtime approval request sync", () => {
  registerProviderApprovalRequestsApprovalCases();
  registerProviderApprovalRequestsResolutionCases();
});
