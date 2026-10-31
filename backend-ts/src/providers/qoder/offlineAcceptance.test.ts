import { afterEach, describe, expect, test } from "bun:test";
import type {
  SDKMessage,
  SDKResultMessage,
  SDKSessionInfo,
  SDKSystemInitMessage,
  SessionMessage
} from "@qoder-ai/qoder-agent-sdk";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildConfig } from "../../config/env.ts";
import { openDatabase } from "../../db/database.ts";
import { getAgentProfile } from "../../db/repositories/agentProfiles.ts";
import { getAgentSession } from "../../db/repositories/agentSessions.ts";
import { listIssueEvents } from "../../db/repositories/issueEvents.ts";
import { createIssueRun } from "../../db/repositories/issueRuns.ts";
import { getIssue, listIssueRuns } from "../../db/repositories/issues.ts";
import { updateIssue } from "../../db/repositories/issueUpdate.ts";
import { createDefaultRouter } from "../../http/server.ts";
import { createProviderRegistry } from "../core/registry.ts";
import { asProviderId, isProviderInterruptedError, type ProviderRunInput } from "../types.ts";
import { runProjectLoopOnce } from "../../runner/projectLoop.ts";
import { runIssueWithProvider } from "../../runner/providerRuntime.ts";
import { qoderFactory } from "./factory.ts";
import { QoderExecutorProvider } from "./provider.ts";
import {
  createFakeQoderSdkFacade,
  type QoderQueryResult,
  type QoderRunOptions,
  type QoderSdkFacade
} from "./sdkFacade.ts";
import type { QoderRuntimeProbe } from "./runtime.ts";

import { BASE_URL, roots, SequentialFacade, HeldFacade, historyFunctions, qoderInit, qoderResult } from "./offlineAcceptanceFixtureBASE_URL.ts";
import { readyProbe, runInput, fixtureRoot, request } from "./offlineAcceptanceFixtureReadyProbe.ts";
import { registerWalksEnabledAgentProfileIssueRun } from "./offlineAcceptanceWalksEnabledAgentProfileIssueRun.cases.ts";
import { registerKeepsConcurrentInterruptScopedClearsLeases } from "./offlineAcceptanceKeepsConcurrentInterruptScopedClearsLeases.cases.ts";

afterEach(async () => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root) await rm(root, { force: true, recursive: true });
  }
});

describe("Qoder Q6 offline acceptance", () => {
  registerWalksEnabledAgentProfileIssueRun();
  registerKeepsConcurrentInterruptScopedClearsLeases();
});
