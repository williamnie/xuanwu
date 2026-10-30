import { describe, expect, test } from "bun:test";
import type { SDKMessage, SDKResultMessage, SDKSessionInfo, SDKSystemInitMessage, SessionMessage } from "@qoder-ai/qoder-agent-sdk";
import { buildConfig } from "../../config/env.ts";
import { checkManifest } from "../core/conformance.ts";
import { createProviderRegistry } from "../core/registry.ts";
import { asProviderId, isProviderInterruptedError, type ProviderEvent } from "../types.ts";
import { qoderFactory, qoderManifest } from "./factory.ts";
import { QoderExecutorProvider } from "./provider.ts";
import {
  createFakeQoderSdkFacade,
  type QoderQueryResult,
  type QoderRunOptions,
  type QoderSdkFacade
} from "./sdkFacade.ts";
import type { QoderRuntimeProbe } from "./runtime.ts";
import type { QoderSessionFunctions } from "./sessionHistory.ts";

import { qoderConfig, readyProbe, init, taskNotification, sdkResult, provider, sessionInfo, history, ConcurrentFacade } from "./providerTestFixtures.ts";
import { registerRunProjectsInitImmediatelyAndThe } from "./providerRunProjectsInitImmediatelyAndThe.cases.ts";
import { registerManifestCapabilitiesMatchTheImplementedProvider } from "./providerManifestCapabilitiesMatchTheImplementedProvider.cases.ts";
import { registerLiveModelDiscoveryExposesOnlyQoder } from "./providerLiveModelDiscoveryExposesOnlyQoder.cases.ts";
import { registerMetadataOnlyReadsSkipEverySDK } from "./providerMetadataOnlyReadsSkipEverySDK.cases.ts";



describe("Qoder Q2 executor lifecycle", () => {
  registerRunProjectsInitImmediatelyAndThe();
});

describe("Qoder Q2 factory conformance", () => {
  registerManifestCapabilitiesMatchTheImplementedProvider();
});

describe("Qoder Q5 models and usage", () => {
  registerLiveModelDiscoveryExposesOnlyQoder();
});

describe("Qoder Q3 Sessions", () => {
  registerMetadataOnlyReadsSkipEverySDK();
});
