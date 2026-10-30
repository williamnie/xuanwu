import { describe, expect, test } from "bun:test";
import { type CodexExecutorProvider, type CodexEventHandler } from "./provider.ts";
import type { CodexInitializeResult, ThreadStartResult, ThreadSummary, TurnStartResult } from "./adapter.ts";
import type { CodexUserInput, ThreadStartInput, TurnStartOptions } from "./threadLifecycle.ts";
import type { ProviderEvent } from "../types.ts";
import { CODEX_EXECUTION_POLICY_CAPABILITIES, codexExecutionPolicyAdapter } from "./executionPolicy.ts";
import { resolveExecutionPolicy } from "../core/policyResolution.ts";
import { EXECUTION_ACCESS_VALUES, EXECUTION_APPROVAL_VALUES } from "../core/policyContracts.ts";

import { FakeCodexIssueAdapter, FakeCodexEventSource, FakeCodexRuntimeControl } from "./providerTestFixtures.ts";
import { registerIssueTurnLLM } from "./providerIssueTurnLLM.cases.ts";
import { registerForwardsLiveCodexAppServerNotifications } from "./providerForwardsLiveCodexAppServerNotifications.cases.ts";
import { registerCreatesManualSessionsAPITurnsResumes } from "./providerCreatesManualSessionsAPITurnsResumes.cases.ts";



describe("Codex executor provider", () => {
  registerIssueTurnLLM();
  registerForwardsLiveCodexAppServerNotifications();
  registerCreatesManualSessionsAPITurnsResumes();
});
