import { describe, expect, test } from "bun:test";
import type { Options, Query, SDKMessage, SDKResultMessage, SDKSystemInitMessage } from "@qoder-ai/qoder-agent-sdk";
import { buildConfig } from "../../config/env.ts";
import { createQoderSdkFacade, QoderExecutionError } from "./sdkFacade.ts";
import { QODER_EXECUTION_POLICY_CAPABILITIES, qoderExecutionPolicyAdapter } from "./executionPolicy.ts";
import { resolveExecutionPolicy } from "../core/policyResolution.ts";
import type { ExecutionPolicyRequest } from "../core/policyContracts.ts";

import { init, result, FakeQuery, config, runOptions, resolvedPolicy } from "./sdkFacadeTestFixtures.ts";
import { registerPromptFreeDiscoveryKeepsInputOpen } from "./sdkFacadePromptFreeDiscoveryKeepsInputOpen.cases.ts";
import { registerProcessErrorsPreserveStructuredClassCode } from "./sdkFacadeProcessErrorsPreserveStructuredClassCode.cases.ts";



describe("Qoder Q2 real facade with offline fake streams", () => {
  registerPromptFreeDiscoveryKeepsInputOpen();
  registerProcessErrorsPreserveStructuredClassCode();
});
