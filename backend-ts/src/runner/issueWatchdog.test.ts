import { describe } from "bun:test";
import { registerIssueWatchdogReadinessCases } from "./issueWatchdogReadinessCases.ts";
import { registerIssueWatchdogEscalationCases } from "./issueWatchdogEscalationCases.ts";

describe("issue watchdog queue readiness", () => {
  registerIssueWatchdogReadinessCases();
  registerIssueWatchdogEscalationCases();
});
