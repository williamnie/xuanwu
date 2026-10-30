import { describe } from "bun:test";
import { registerProjectLoopExecutionCases } from "./projectLoopExecutionCases.ts";
import { registerProjectLoopPolicyCases } from "./projectLoopPolicyCases.ts";
import { registerProjectLoopProfilesCases } from "./projectLoopProfilesCases.ts";
import { registerProjectLoopRecoveryCases } from "./projectLoopRecoveryCases.ts";

describe("Bun project loop claim execution", () => {
  registerProjectLoopExecutionCases();
  registerProjectLoopPolicyCases();
  registerProjectLoopProfilesCases();
  registerProjectLoopRecoveryCases();
});
