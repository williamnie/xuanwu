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

export function registerWalksEnabledAgentProfileIssueRun() {
test("walks enabled agent -> profile -> Issue/Run/Attempt -> events -> Session/Runs -> two resumes", async () => {
    const root = await fixtureRoot("xuanwu-qoder-q6-");
    const stateDir = join(root, "state");
    const database = await openDatabase({ stateDir });
    const facade = new SequentialFacade();
    let invocation = 0;
    let session = 0;
    try {
      const config = buildConfig({
        dbPath: database.path,
        qoderEnabled: false,
        stateDir
      });
      const registry = createProviderRegistry();
      registry.registerFactory(qoderFactory({
        facade,
        invocationIdFactory: () => `qoder-q6-inv-${++invocation}`,
        runtimeProbe: () => readyProbe(),
        sessionFunctions: historyFunctions(),
        sessionIdFactory: () => `qoder-q6-session-${++session}`
      }));
      await registry.startConfigured(config.providers);
      const providers = registry.readyProviders();
      const router = createDefaultRouter({ config, database, providers, providersRegistry: registry });

      expect(registry.describe(asProviderId("qoder")).state).toBe("disabled");
      const enabled = await request(router, "/api/code-agents/qoder", "PATCH", { enabled: true });
      expect(enabled.status).toBe(200);
      expect(await enabled.json()).toMatchObject({
        agents: [{ id: "qoder", state: "ready", submittable: true }],
        available_ids: ["qoder"]
      });
      expect(getAgentProfile(database, "xuanwu-provider-qoder")).toMatchObject({
        id: "xuanwu-provider-qoder",
        model: "",
        provider: "qoder"
      });

      const createdProject = await request(router, "/api/projects", "POST", {
        auto_run: false,
        cwd: root,
        default_agent_profile_id: "xuanwu-provider-qoder",
        id: "qoder-q6",
        model: "performance",
        provider: "qoder"
      });
      expect(createdProject.status).toBe(201);
      expect(await createdProject.json()).toMatchObject({
        default_agent_profile_id: "xuanwu-provider-qoder",
        model: "performance",
        provider: "qoder"
      });

      const createdIssue = await request(router, "/api/issues", "POST", {
        agent_profile_id: "xuanwu-provider-qoder",
        description: "Run the isolated Qoder fixture without network access.",
        issue_log_mode: "debug",
        project_id: "qoder-q6",
        status: "triage",
        title: "Qoder Q6 fixture"
      });
      expect(createdIssue.status).toBe(201);
      const issue = await createdIssue.json() as { id: number };
      updateIssue(database, issue.id, { status: "todo" });

      const loop = await runProjectLoopOnce({ database, projectId: "qoder-q6", providers });
      expect(loop).toMatchObject({ claimed: true, issue: { id: issue.id } });
      const run = listIssueRuns(database, issue.id).at(-1);
      expect(run).toMatchObject({
        agent_profile_id: "xuanwu-provider-qoder",
        provider: "qoder",
        provider_session_id: "qoder-q6-session-1",
        provider_turn_id: "qoder-q6-result-1",
        selection_reason: "issue assigned agent_profile_id",
        status: "succeeded"
      });
      expect(JSON.parse(run?.runtime_metadata_json ?? "{}")).toMatchObject({ run_id: "qoder-q6-inv-1" });
      expect(getIssue(database, issue.id)?.status).toBe("in_progress");
      expect(getAgentSession(database, "qoder:qoder-q6-session-1")).toMatchObject({
        issue_id: issue.id,
        provider: "qoder",
        status: "completed"
      });

      const persistedEvents = listIssueEvents(database, issue.id);
      const persisted = JSON.stringify(persistedEvents);
      expect(persisted).toContain("qoder/future_event");
      expect(persistedEvents.some((event) => {
        const payload = event.payload ? JSON.parse(event.payload) as Record<string, any> : {};
        return payload.raw_method === "qoder/future_event" && payload.run_event?.kind === "unknown" &&
          payload.run_event?.terminal === false;
      })).toBe(true);
      expect(persisted).not.toContain("fixture-secret");
      expect(database.sqlite.query<{ status: string }, [number]>(`
        select attempt.status from run_attempts attempt
        join issue_runs run on run.id=attempt.issue_run_id
        where run.issue_id=? order by attempt.sequence desc limit 1
      `).get(issue.id)?.status).toBe("succeeded");

      const runId = `xw:run:issue_runs:${run?.id}`;
      const runDetail = await request(router, `/api/runs/${encodeURIComponent(runId)}`);
      expect(runDetail.status).toBe(200);
      const runBody = await runDetail.json() as Record<string, any>;
      const observationRef = runBody.run.attempts[0].provider_ref.observation_ref;
      expect(observationRef).toBe("qoder:qoder-q6-session-1");
      expect(runBody.run.attempts[0]).toMatchObject({
        provider_ref: {
          invocation_ref: run?.id,
          provider: "qoder",
          session_ref: "qoder-q6-session-1",
          turn_ref: "qoder-q6-result-1"
        },
        status: "succeeded"
      });

      const sessionDetail = await request(router, `/api/sessions/${encodeURIComponent(observationRef)}`);
      expect(sessionDetail.status).toBe(200);
      expect(await sessionDetail.json()).toMatchObject({
        id: "qoder:qoder-q6-session-1",
        provider: "qoder",
        session_contract: "xw.provider-session.v1",
        turns: []
      });
      const sessionTurns = await request(
        router,
        `/api/sessions/${encodeURIComponent(observationRef)}/turns?items_view=summary&limit=20`
      );
      expect(sessionTurns.status).toBe(200);
      expect(await sessionTurns.json()).toMatchObject({
        data: [{ items: [{ type: "userMessage" }, { type: "agentMessage" }] }]
      });

      for (const prompt of ["resume round one", "resume round two"]) {
        const resumed = await request(
          router,
          `/api/sessions/${encodeURIComponent(observationRef)}/messages`,
          "POST",
          { prompt }
        );
        expect(resumed.status).toBe(201);
        expect(await resumed.json()).toMatchObject({
          provider: "qoder",
          thread_id: "qoder-q6-session-1"
        });
      }
      expect(facade.calls).toHaveLength(3);
      expect(facade.calls[0]).toMatchObject({ sessionId: "qoder-q6-session-1" });
      for (const call of facade.calls.slice(1)) {
        expect(call).toMatchObject({ resume: "qoder-q6-session-1" });
        expect(call).not.toHaveProperty("sessionId");
      }
      expect(JSON.parse(getAgentSession(database, "qoder:qoder-q6-session-1")?.raw_ref ?? "{}")).toMatchObject({
        provider_turn_id: "qoder-q6-result-3"
      });
      expect(registry.collectProcessLeases()).toEqual([]);
    } finally {
      database.close();
    }
  });
}
