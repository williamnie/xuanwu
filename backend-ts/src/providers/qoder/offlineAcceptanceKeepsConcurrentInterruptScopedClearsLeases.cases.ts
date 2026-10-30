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

export function registerKeepsConcurrentInterruptScopedClearsLeases() {
test("keeps concurrent interrupt scoped, clears leases, and redacts a failed terminal", async () => {
    const held = new HeldFacade();
    let invocation = 0;
    let session = 0;
    const provider = new QoderExecutorProvider(buildConfig().providers.qoder!, {
      facade: held,
      invocationIdFactory: () => `held-inv-${++invocation}`,
      readiness: readyProbe(),
      sessionIdFactory: () => `held-session-${++session}`
    });
    const first = provider.run(runInput(1, "first"));
    const second = provider.run(runInput(2, "second"));
    await held.ready;

    expect(provider.processLeases().map((lease) => lease.invocationOwner).sort()).toEqual(["held-inv-1", "held-inv-2"]);
    await provider.interrupt({ session: { provider: "qoder", sessionId: "held-session-1" } });
    held.succeed("held-inv-2");
    expect(await first.catch((error) => error)).toSatisfy(isProviderInterruptedError);
    await expect(second).resolves.toMatchObject({ session: { sessionId: "held-session-2" } });
    expect(held.interrupted).toEqual(["held-inv-1"]);
    expect(provider.processLeases()).toEqual([]);
    expect(provider.runtimeStatus().active_sessions).toBe(0);

    const root = await fixtureRoot("xuanwu-qoder-q6-failure-");
    const database = await openDatabase({ stateDir: join(root, "state") });
    try {
      database.sqlite.run(
        `insert into projects (id, name, cwd, created_at, updated_at) values (?, ?, ?, ?, ?)`,
        ["failure", "failure", root, "2026-08-12T00:00:00Z", "2026-08-12T00:00:00Z"]
      );
      database.sqlite.run(
        `insert into issues (project_id, title, status, created_at, updated_at) values (?, ?, ?, ?, ?)`,
        ["failure", "Qoder failure", "in_progress", "2026-08-12T00:00:00Z", "2026-08-12T00:00:00Z"]
      );
      const issueId = Number(database.sqlite.query<{ id: number }, []>("select last_insert_rowid() as id").get()?.id);
      const issueRunId = createIssueRun(database, issueId).id;
      const sessionId = "qoder-failed-session";
      const fake = createFakeQoderSdkFacade([
        qoderInit(sessionId),
        qoderResult(sessionId, 1, {
          errors: ["QODER_PERSONAL_ACCESS_TOKEN=fixture-secret"],
          is_error: true,
          subtype: "error_during_execution"
        })
      ]);
      const failing = new QoderExecutorProvider(buildConfig().providers.qoder!, {
        facade: fake.facade,
        invocationIdFactory: () => "qoder-failed-inv",
        readiness: readyProbe(),
        sessionIdFactory: () => sessionId
      });

      await expect(runIssueWithProvider(failing, {
        cwd: root,
        database,
        issueId,
        issueRunId,
        projectId: "failure",
        prompt: "fail safely"
      })).rejects.toThrow();
      const rows = JSON.stringify({
        events: listIssueEvents(database, issueId),
        runs: listIssueRuns(database, issueId)
      });
      expect(rows).not.toContain("fixture-secret");
      expect(listIssueRuns(database, issueId).at(-1)).toMatchObject({ status: "failed" });
      expect(database.sqlite.query<{ count: number }, [number]>(`
        select count(*) as count from run_attempts attempt
        join issue_runs run on run.id=attempt.issue_run_id
        where run.issue_id=? and attempt.status='failed'
      `).get(issueId)?.count).toBe(1);
    } finally {
      database.close();
    }
  });
}
