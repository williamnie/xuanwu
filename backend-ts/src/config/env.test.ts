import { describe } from "bun:test";
import { registerEnvDefaultsCases } from "./envDefaultsCases.ts";
import { registerEnvArgumentsCases } from "./envArgumentsCases.ts";
import { registerEnvProvidersCases } from "./envProvidersCases.ts";
import { registerEnvCredentialsCases } from "./envCredentialsCases.ts";
import { registerEnvIntegrationsCases } from "./envIntegrationsCases.ts";

describe("Bun backend config", () => {
  registerEnvDefaultsCases();
  registerEnvArgumentsCases();
  registerEnvProvidersCases();
  registerEnvCredentialsCases();
  registerEnvIntegrationsCases();
});
