import { describe } from "bun:test";
import { registerServiceLifecycleCases } from "./serviceLifecycleCases.ts";
import { registerServiceRecoveryCases } from "./serviceRecoveryCases.ts";
import { registerServiceCanonicalRefsCases } from "./serviceCanonicalRefsCases.ts";

describe("Run lifecycle command service", () => {
  registerServiceLifecycleCases();
  registerServiceRecoveryCases();
});

describe("P1: canonical refs 支持 session-only resume 与 fail-closed", () => {
  registerServiceCanonicalRefsCases();
});
