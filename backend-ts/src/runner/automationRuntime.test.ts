import { describe } from "bun:test";
import { registerAutomationRuntimeSchedulingCases } from "./automationRuntimeSchedulingCases.ts";
import { registerAutomationRuntimeCommitmentsCases } from "./automationRuntimeCommitmentsCases.ts";

describe("native Automation scheduler composition", () => {
  registerAutomationRuntimeSchedulingCases();
  registerAutomationRuntimeCommitmentsCases();
});
