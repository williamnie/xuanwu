import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderRuntimeConfig } from "../../config/env.ts";
import { openDatabase, type RunnerDatabase } from "../../db/database.ts";
import { createIssueRun } from "../../db/repositories/issueRuns.ts";
import { listIssueEvents } from "../../db/repositories/issueEvents.ts";
import { getIssue, listIssueRuns } from "../../db/repositories/issues.ts";
import { cancelIssueWithInterrupt } from "../../runner/interrupt.ts";
import { runProjectLoopOnce } from "../../runner/projectLoop.ts";
import { runIssueWithProvider } from "../../runner/providerRuntime.ts";
import { ClaudeExecutorProvider, ClaudeSdkExecutorProvider, type ClaudeProcessFactory } from "./provider.ts";
import { inspectClaudeCliAuth } from "./cliProvider.ts";
import type { Options as ClaudeSdkOptions } from "@anthropic-ai/claude-agent-sdk";
import { CLAUDE_EXECUTION_POLICY_CAPABILITIES, claudeExecutionPolicyAdapter } from "./executionPolicy.ts";
import { resolveExecutionPolicy } from "../core/policyResolution.ts";

import { tempRoots, runtimeConfig, runInput, claudePolicy, rejectedError, scriptedProcessFactory, hangingProcessFactory, stubbornProcessFactory, streamFrom, closableStream, waitFor, jsonl, openFixtureDatabase, insertProject, insertIssue } from "./providerTestFixtures.ts";
import { registerSDKFullUnattendedUsesExplicitBypass } from "./providerSDKFullUnattendedUsesExplicitBypass.cases.ts";
import { registerReportsExplicitLocalCLILoginAnd } from "./providerReportsExplicitLocalCLILoginAnd.cases.ts";
import { registerCancelledClaudeRunDoesNotFail } from "./providerCancelledClaudeRunDoesNotFail.cases.ts";

afterEach(async () => {
  while (tempRoots.length > 0) {
    const path = tempRoots.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

describe("Claude Code provider", () => {
  registerSDKFullUnattendedUsesExplicitBypass();
  registerReportsExplicitLocalCLILoginAnd();
  registerCancelledClaudeRunDoesNotFail();
});
