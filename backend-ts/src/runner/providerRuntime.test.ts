import { describe } from "bun:test";
import { registerProviderRuntimeRuntimeCases } from "./providerRuntimeRuntimeCases.ts";
import { registerProviderRuntimeSessionsCases } from "./providerRuntimeSessionsCases.ts";
import { registerProviderRuntimeRecoveryCases } from "./providerRuntimeRecoveryCases.ts";

describe("executor provider runtime seam", () => {
  registerProviderRuntimeRuntimeCases();
  registerProviderRuntimeSessionsCases();
  registerProviderRuntimeRecoveryCases();
});
