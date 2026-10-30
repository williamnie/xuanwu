import { describe } from "bun:test";
import { registerPiIssueSupervisorSchedulerSchedulingCases } from "./piIssueSupervisorSchedulerSchedulingCases.ts";
import { registerPiIssueSupervisorSchedulerDecisionsCases } from "./piIssueSupervisorSchedulerDecisionsCases.ts";
import { registerPiIssueSupervisorSchedulerRecoveryCases } from "./piIssueSupervisorSchedulerRecoveryCases.ts";
import { registerPiIssueSupervisorSchedulerMaintenanceCases } from "./piIssueSupervisorSchedulerMaintenanceCases.ts";

describe("PI issue supervisor scheduler", () => {
  registerPiIssueSupervisorSchedulerSchedulingCases();
  registerPiIssueSupervisorSchedulerDecisionsCases();
  registerPiIssueSupervisorSchedulerRecoveryCases();
  registerPiIssueSupervisorSchedulerMaintenanceCases();
});
