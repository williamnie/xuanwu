import { describe, expect, test } from "bun:test";
import {
  classifyPiActionRisk,
  gatePiActionEnvelope
} from "./actionEngine.ts";
import type { PiGatePolicy } from "./actionGate.ts";


import { registerClassifiesSafeConfirmRequiredAndHigh } from "./actionEngineClassifiesSafeConfirmRequiredAndHigh.cases.ts";
import { registerManualModeStillExecutesTrustedRead } from "./actionEngineManualModeStillExecutesTrustedRead.cases.ts";



describe("PI action engine risk classifier", () => {
  registerClassifiesSafeConfirmRequiredAndHigh();
  registerManualModeStillExecutesTrustedRead();
});
