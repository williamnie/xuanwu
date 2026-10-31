import { describe } from "bun:test";
import { registerPiAcceptanceApplicationOutcomesCases } from "./piAcceptanceApplicationOutcomesCases.ts";
import { registerPiAcceptanceApplicationContinuationCases } from "./piAcceptanceApplicationContinuationCases.ts";
import { registerPiAcceptanceApplicationPlanningCases } from "./piAcceptanceApplicationPlanningCases.ts";

describe("PI acceptance decision application", () => {
  registerPiAcceptanceApplicationOutcomesCases();
  registerPiAcceptanceApplicationContinuationCases();
  registerPiAcceptanceApplicationPlanningCases();
});
