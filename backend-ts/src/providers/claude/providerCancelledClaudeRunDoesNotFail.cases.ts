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

export function registerCancelledClaudeRunDoesNotFail() {
test("cancelled Claude run does not fail or pollute the next project loop claim", async () => {
    const db = await openFixtureDatabase();
    const factory = hangingProcessFactory();
    const provider = new ClaudeExecutorProvider(runtimeConfig({ timeoutMs: 30_000 }), {
      processFactory: factory.factory,
      sessionIdFactory: () => "session-next-cancel"
    });
    const cwd = await mkdtemp(join(tmpdir(), "xuanwu-bun-claude-next-cwd-"));
    tempRoots.push(cwd);
    insertProject(db, "demo", cwd);
    const issueId = insertIssue(db, "demo", "todo");
    const running = runProjectLoopOnce({ database: db, projectId: "demo", providers: { claude: provider } });

    await waitFor(() => listIssueRuns(db, issueId)[0]?.provider_session_id === "session-next-cancel");
    await cancelIssueWithInterrupt(db, issueId, {
      interruptTimeoutMs: 50,
      providers: { claude: provider }
    });
    await running;

    expect(getIssue(db, issueId)).toMatchObject({ status: "cancelled", error: "" });
    expect(listIssueRuns(db, issueId)[0]).toMatchObject({
      status: "cancelled",
      exit_reason: "issue_cancel",
      error: ""
    });
  });
}
