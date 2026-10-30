import { describe } from "bun:test";
import { registerPiAutoManageSchedulerSchedulingCases } from "./piAutoManageSchedulerSchedulingCases.ts";
import { registerPiAutoManageSchedulerConcurrencyCases } from "./piAutoManageSchedulerConcurrencyCases.ts";
import { registerPiAutoManageSchedulerRecoveryCases } from "./piAutoManageSchedulerRecoveryCases.ts";
import { registerPiAutoManageSchedulerWatchdogCases } from "./piAutoManageSchedulerWatchdogCases.ts";

describe("PI auto-manage scheduler", () => {
  registerPiAutoManageSchedulerSchedulingCases();
  registerPiAutoManageSchedulerConcurrencyCases();
  registerPiAutoManageSchedulerRecoveryCases();
  registerPiAutoManageSchedulerWatchdogCases();
});
