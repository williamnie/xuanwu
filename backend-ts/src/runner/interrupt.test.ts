import { describe } from "bun:test";
import { registerInterruptInterruptionCases } from "./interruptInterruptionCases.ts";
import { registerInterruptRestartCases } from "./interruptRestartCases.ts";

describe("Bun issue interrupt runtime", () => {
  registerInterruptInterruptionCases();
  registerInterruptRestartCases();
});
