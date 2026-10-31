import { expect, test } from "bun:test";

import { getIssue, listIssueRuns } from "../db/repositories/issues.ts";
import { listIssueEvents } from "../db/repositories/issueEvents.ts";

import { isProjectLoopActive, setProjectLoopMaxParallelProjects, startProjectLoop } from "./projectLoopManager.ts";

import { FIXTURE_TIME, insertRow } from "../testing/harness.ts";
import {
  STARTED,
  DONE,
  FAKE,
  ScriptedProvider,
  openFixtureDatabase,
  PROVIDER_FAILURE,
  INITIALIZE_TIMEOUT,
  addProject,
  addIssue,
  runOnce,
  settle,
  listEventTypes,
  latestEventPayload
} from "./projectLoopTestFixtures.ts";

export function registerProjectLoopPolicyCases() {
  test("auto-run can start different projects up to the global concurrency limit", async () => {
    const db = await openFixtureDatabase();
    const provider = new ScriptedProvider();
    setProjectLoopMaxParallelProjects(2);
    addProject(db, "project-a", provider.id, { auto_run: 1 });
    addProject(db, "project-b", provider.id, { auto_run: 1 });
    const first = addIssue(db, "project-a", "first");
    const second = addIssue(db, "project-b", "second");

    startProjectLoop({ database: db, providers: { [provider.id]: provider } }, "project-a");
    startProjectLoop({ database: db, providers: { [provider.id]: provider } }, "project-b");
    await settle(() => provider.inputs.length === 2);
    await settle(() => !isProjectLoopActive("project-a") && !isProjectLoopActive("project-b"));

    expect(provider.inputs.map((input) => input.issueId).sort((a, b) => a - b)).toEqual([first, second]);
    expect(getIssue(db, first)).toMatchObject({ status: "in_progress", attempt_count: 1 });
    expect(getIssue(db, second)).toMatchObject({ status: "in_progress", attempt_count: 1 });
  });

  test("isolates loop queues for separate databases that reuse a project id", async () => {
    const [firstDB, secondDB] = [await openFixtureDatabase(), await openFixtureDatabase()];
    const [firstProvider, secondProvider] = [new ScriptedProvider(), new ScriptedProvider()];
    addProject(firstDB, "demo", firstProvider.id, { auto_run: 1 });
    addProject(secondDB, "demo", secondProvider.id, { auto_run: 1 });
    addIssue(firstDB, "demo", "first database");
    addIssue(secondDB, "demo", "second database");

    startProjectLoop({ database: firstDB, providers: { [firstProvider.id]: firstProvider } }, "demo");
    startProjectLoop({ database: secondDB, providers: { [secondProvider.id]: secondProvider } }, "demo");
    await settle(() => firstProvider.inputs.length === 1 && secondProvider.inputs.length === 1);
    await settle(() => !isProjectLoopActive("demo", firstDB) && !isProjectLoopActive("demo", secondDB));

    expect(firstProvider.inputs[0]).toMatchObject({ projectId: "demo", prompt: expect.stringContaining("first database") });
    expect(secondProvider.inputs[0]).toMatchObject({ projectId: "demo", prompt: expect.stringContaining("second database") });
  });

  test("explicit project hold blocks auto-run and forced execution without creating a Run", async () => {
    const db = await openFixtureDatabase();
    const provider = new ScriptedProvider();
    addProject(db, "held", provider.id, { auto_run: 1 });
    const issueID = addIssue(db, "held", "held issue");
    insertRow(db, "project_holds", {
      project_id: "held", reason: "user_pause", message: "explicit fixture hold", hold_since: FIXTURE_TIME, updated_at: FIXTURE_TIME
    });

    startProjectLoop({ database: db, providers: { [provider.id]: provider } }, "held", { forceOnce: true });
    await settle(() => !isProjectLoopActive("held"));

    expect(provider.inputs).toEqual([]);
    expect(getIssue(db, issueID)).toMatchObject({ status: "todo", attempt_count: 0 });
    expect(listIssueRuns(db, issueID)).toEqual([]);
    expect(latestEventPayload(db, issueID, "issue.runner_scope_decision")).toMatchObject({
      authority: "project_holds", decision: "stop", reason: "project_hold", scope: "project:held"
    });
  });

  test("provider runtime blocker stays provider-scoped while another provider keeps running", async () => {
    const db = await openFixtureDatabase();
    const healthy = new ScriptedProvider();
    addProject(db, "missing-codex", "codex", { auto_run: 1 });
    addProject(db, "healthy", healthy.id, { auto_run: 1 });
    const blocked = addIssue(db, "missing-codex", "provider blocked");
    const runnable = addIssue(db, "healthy", "provider ready");
    const runtime = { database: db, providers: { [healthy.id]: healthy } };

    startProjectLoop(runtime, "missing-codex");
    startProjectLoop(runtime, "healthy");
    await settle(() => healthy.inputs.length === 1);
    await settle(() => !isProjectLoopActive("missing-codex") && !isProjectLoopActive("healthy"));

    expect(healthy.inputs.map((input) => input.issueId)).toEqual([runnable]);
    expect(getIssue(db, blocked)).toMatchObject({ status: "todo", attempt_count: 0 });
    expect(listIssueRuns(db, blocked)).toEqual([]);
    expect(latestEventPayload(db, blocked, "issue.runner_scope_decision")).toMatchObject({
      authority: "runner.providers", decision: "stop", provider: "codex", reason: "provider_runtime", scope: "provider:codex"
    });
  });

  test("a provider terminal failure holds only its project while another project can run", async () => {
    const db = await openFixtureDatabase();
    const outage = new ScriptedProvider("claude", { fail: INITIALIZE_TIMEOUT });
    const healthy = new ScriptedProvider();
    addProject(db, "outage", outage.id, { auto_run: 1 });
    addProject(db, "other-provider", healthy.id, { auto_run: 1 });
    const deferred = addIssue(db, "outage", "deferred");
    const runnable = addIssue(db, "other-provider", "other provider");
    const runtime = { database: db, providers: { [outage.id]: outage, [healthy.id]: healthy } };

    startProjectLoop(runtime, "outage");
    await settle(() => listEventTypes(db, deferred).includes("issue.pi_acceptance_requested.v1"));
    startProjectLoop(runtime, "other-provider");
    await settle(() => healthy.inputs.length === 1);

    expect(healthy.inputs.map((input) => input.issueId)).toEqual([runnable]);
    expect(getIssue(db, deferred)).toMatchObject({ status: "in_progress" });
  });

  for (const [name, script] of [
    ["provider startup failure stays in the same Issue for PI and blocks its sibling", { fail: PROVIDER_FAILURE }],
    ["executor failed waits for PI before the project can run a sibling", {
      events: [STARTED, { error: "executor reported a scoped failure", status: "failed", type: "error" }]
    }]
  ] as const) {
    test(name, async () => {
      const db = await openFixtureDatabase();
      const provider = new ScriptedProvider(FAKE, script);
      addProject(db, "demo", provider.id, { auto_run: 1 });
      const first = addIssue(db, "demo", "first");
      const second = addIssue(db, "demo", "second");

      await runOnce(db, provider);

      expect(provider.inputs.map((input) => input.issueId)).toEqual([first]);
      expect(getIssue(db, first)).toMatchObject({ status: "in_progress", attempt_count: 1 });
      expect(getIssue(db, second)).toMatchObject({ status: "todo", attempt_count: 0 });
      expect(listIssueRuns(db, second)).toHaveLength(0);
    });
  }

  test("auto-run records provider startup failure as terminal Run facts for PI", async () => {
    const db = await openFixtureDatabase();
    const provider = new ScriptedProvider("claude", { fail: INITIALIZE_TIMEOUT });
    addProject(db, "infra-demo", provider.id, { auto_run: 1 });
    const first = addIssue(db, "infra-demo", "first");
    const second = addIssue(db, "infra-demo", "second");

    await runOnce(db, provider, "infra-demo");

    expect(provider.inputs.map((input) => input.issueId)).toEqual([first]);
    expect(getIssue(db, first)).toMatchObject({ status: "in_progress", auto_retry_reason: "", auto_retry_next_at: "", error: "" });
    expect(listIssueRuns(db, first).at(-1)).toMatchObject({
      provider: "claude",
      status: "failed",
      ended_at: expect.stringMatching(/Z$/),
      exit_reason: "provider_reported_failed",
      error: INITIALIZE_TIMEOUT
    });
    expect(getIssue(db, second)).toMatchObject({ status: "todo", attempt_count: 0 });
    expect(listIssueRuns(db, second)).toEqual([]);
    expect(listEventTypes(db, first)).not.toContain("issue.provider_deferred");
  });

  test("keeps auth and quota failures terminal even when wrapped in transport wording", async () => {
    for (const fail of ["transport error: 401 unauthorized", "network error: insufficient quota"]) {
      const db = await openFixtureDatabase();
      const provider = new ScriptedProvider(FAKE, { fail });
      addProject(db, "demo", provider.id);
      const issueId = addIssue(db, "demo", "terminal provider failure");

      await runOnce(db, provider);

      expect(getIssue(db, issueId)).toMatchObject({ status: "in_progress", error: "" });
      expect(listIssueRuns(db, issueId).at(-1)).toMatchObject({ status: "failed", exit_reason: "provider_reported_failed" });
      expect(listEventTypes(db, issueId)).not.toContain("issue.provider_deferred");
    }
  });

  test("forced loop starts one executor session even when project auto-run is off", async () => {
    const db = await openFixtureDatabase();
    const provider = new ScriptedProvider();
    addProject(db, "manual-demo", provider.id);
    const issueId = addIssue(db, "manual-demo", "from IM");

    await runOnce(db, provider, "manual-demo");

    expect(provider.inputs.map((input) => input.issueId)).toEqual([issueId]);
    expect(getIssue(db, issueId)).toMatchObject({ status: "in_progress", attempt_count: 1 });
  });

  test("reconciles a completed provider session and closes the Run", async () => {
    const db = await openFixtureDatabase();
    const provider = new ScriptedProvider(FAKE, { events: [STARTED, DONE] });
    addProject(db, "demo", provider.id);
    const issueId = addIssue(db, "demo", "needs explicit status");

    await runOnce(db, provider);

    expect(getIssue(db, issueId)).toMatchObject({ status: "in_progress" });
    expect(listIssueRuns(db, issueId)).toMatchObject([{ status: "succeeded", ended_at: expect.stringMatching(/Z$/) }]);
    expect(listIssueEvents(db, issueId, { types: ["issue.pi_acceptance_requested.v1"] })).toHaveLength(1);
  });
}
