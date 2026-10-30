import { describe } from "bun:test";
import { registerProcessGroupMemorySamplingCases } from "./processGroupMemorySamplingCases.ts";
import { registerProcessGroupMemoryAttributionCases } from "./processGroupMemoryAttributionCases.ts";
import { registerProcessGroupMemoryBudgetsCases } from "./processGroupMemoryBudgetsCases.ts";
import { registerProcessGroupMemoryAlertsCases } from "./processGroupMemoryAlertsCases.ts";

describe("runner process-group memory observer", () => {
  registerProcessGroupMemorySamplingCases();
  registerProcessGroupMemoryAttributionCases();
  registerProcessGroupMemoryBudgetsCases();
  registerProcessGroupMemoryAlertsCases();
});
