import { describe, expect, test } from "bun:test";
import { asProviderId, type ProviderEvent } from "../types.ts";
import { PiRpcTransport, piRpcChildEnv, type PiRpcCommand, type PiRpcEvent } from "./rpcTransport.ts";
import { PiExecutorProvider } from "./provider.ts";
import { piFactory, piManifest } from "./factory.ts";
import { createProviderRegistry } from "../core/registry.ts";
import { PI_EXECUTION_POLICY_CAPABILITIES, piExecutionPolicyAdapter } from "./executionPolicy.ts";
import { resolveExecutionPolicy } from "../core/policyResolution.ts";
import type { ExecutionPolicyRequest } from "../core/policyContracts.ts";
import xuanwuPolicyExtension from "./xuanwuPolicyExtension.ts";

import { FakePiTransport, piPolicy, waitFor } from "./providerTestFixtures.ts";
import { registerResponseCommandIdData } from "./providerResponseCommandIdData.cases.ts";
import { registerReadSessionPiSessionTranscript } from "./providerReadSessionPiSessionTranscript.cases.ts";
import { registerSession } from "./providerSession.cases.ts";
import { registerApprovalBridgeLoadFailureIsTerminal } from "./providerApprovalBridgeLoadFailureIsTerminal.cases.ts";
import { registerManifestNativeReadList } from "./providerManifestNativeReadList.cases.ts";



describe("P10: Pi RPC transport 协议", () => {
  registerResponseCommandIdData();
});

describe("P10: Pi executor（fake transport）", () => {
  registerReadSessionPiSessionTranscript();
  registerSession();
  registerApprovalBridgeLoadFailureIsTerminal();
});

describe("P10: Pi factory 与 manifest", () => {
  registerManifestNativeReadList();
});
