import { describe } from "bun:test";
import { registerEventSummaryProjectorProjectionCases } from "./eventSummaryProjectorProjectionCases.ts";
import { registerEventSummaryProjectorReadsCases } from "./eventSummaryProjectorReadsCases.ts";

describe("event summary projector", () => {
  registerEventSummaryProjectorProjectionCases();
  registerEventSummaryProjectorReadsCases();
});
