import { describe } from "bun:test";
import { registerPiAcceptanceCoordinatorCoordinationCases } from "./piAcceptanceCoordinatorCoordinationCases.ts";
import { registerPiAcceptanceCoordinatorContinuationCases } from "./piAcceptanceCoordinatorContinuationCases.ts";
import { registerPiAcceptanceCoordinatorLatestTurnCases } from "./piAcceptanceCoordinatorLatestTurnCases.ts";

describe("issue-scoped PI acceptance coordinator", () => {
  registerPiAcceptanceCoordinatorCoordinationCases();
  registerPiAcceptanceCoordinatorContinuationCases();
  registerPiAcceptanceCoordinatorLatestTurnCases();
});
