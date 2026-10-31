import { describe } from "bun:test";
import { registerRuntimeRuntimeCases } from "./runtimeRuntimeCases.ts";
import { registerRuntimeWorkflowsCases } from "./runtimeWorkflowsCases.ts";

describe("controlled skill runtime", () => {
  registerRuntimeRuntimeCases();
  registerRuntimeWorkflowsCases();
});
