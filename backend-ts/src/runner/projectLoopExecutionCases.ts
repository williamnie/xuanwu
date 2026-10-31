import { expect, test } from "bun:test";

import { getAgentSession } from "../db/repositories/agentSessions.ts";
import { getIssue, listIssueRuns } from "../db/repositories/issues.ts";
import { listIssueEvents, recordIssueEvent } from "../db/repositories/issueEvents.ts";

import { isProjectLoopActive, startProjectLoop } from "./projectLoopManager.ts";

import {
  TURN_STARTED,
  DONE,
  FAKE,
  ScriptedProvider,
  openFixtureDatabase,
  addProject,
  addIssue,
  runOnce,
  promptFor,
  settle,
  insertOpenRun
} from "./projectLoopTestFixtures.ts";

export function registerProjectLoopExecutionCases() {
  test("claims a single todo issue by runner order and starts provider run", async () => {
    const db = await openFixtureDatabase();
    const provider = new ScriptedProvider();
    addProject(db, "demo", provider.id);
    const laterHigh = addIssue(db, "demo", "later high", { priority: 5, created_at: "2026-01-03T00:00:00Z" });
    const firstHigh = addIssue(db, "demo", "first high", { priority: 5, created_at: "2026-01-02T00:00:00Z" });
    const low = addIssue(db, "demo", "low", { priority: 1 });

    const result = await runOnce(db, provider);

    expect(result.claimed).toBe(true);
    if (!result.claimed) throw new Error("expected claim");
    expect(result.issue.id).toBe(firstHigh);
    expect(provider.inputs).toHaveLength(1);
    expect(provider.inputs[0]).toMatchObject({ issueId: firstHigh, projectId: "demo" });
    expect(provider.inputs[0]?.prompt).toContain("first high");
    expect(getIssue(db, firstHigh)).toMatchObject({ status: "in_progress", attempt_count: 1 });
    expect(getIssue(db, laterHigh)).toMatchObject({ status: "todo" });
    expect(getIssue(db, low)).toMatchObject({ status: "todo" });
    expect(listIssueRuns(db, firstHigh)).toMatchObject([{
      attempt: 1,
      status: "in_progress",
      provider: "fake-execution-only",
      provider_session_id: `fake-session-${firstHigh}`,
      provider_turn_id: `fake-turn-${firstHigh}`,
      runtime_metadata_json: `{"run_id":"fake-run-${firstHigh}","resolved_settings":{"approval_policy":"never","model":"","reasoning_effort":"","sandbox":"workspace-write","service_tier":"","service_tier_source":"standard"}}`,
      ended_at: ""
    }]);
    expect(getAgentSession(db, `fake-execution-only:fake-session-${firstHigh}`)).toMatchObject({
      provider: "fake-execution-only",
      provider_session_id: `fake-session-${firstHigh}`,
      issue_id: firstHigh,
      status: "running"
    });
  });

  test("sends the canonical issue prompt with the authoritative execution contract", async () => {
    const prompt = await promptFor({ description: "Add the focused runner prompt guidance.", title: "prompt contract" });

    for (const fragment of [
      "# prompt contract\n\nAdd the focused runner prompt guidance.",
      "## Xuanwu execution context (authoritative)",
      "already claimed Issue #1",
      "Do not create, deduplicate, enqueue, retry, cancel, delete, or change the status of this Issue",
      "Report `completed` when you have satisfied the Issue goal",
      "Do not use it merely because the Issue is conversational or requires no repository changes",
      "RUNNER_OUTCOME: needs_user | <reason>"
    ]) expect(prompt).toContain(fragment);
  });

  test("injects the latest governed Supervisor retry resolution into the new attempt prompt", async () => {
    const prompt = await promptFor({
      description: "Implement the batch upload handler without unrelated changes.",
      title: "batch upload"
    }, (db, issueID) => recordIssueEvent(db, issueID, "issue.supervisor_retry", {
      decision_id: "decision-batch-contract",
      reason: "The user explicitly authorized a backward-compatible public API contract extension for batch upload."
    }));

    expect(prompt).toContain("## Governed retry context");
    expect(prompt).toContain("Decision: decision-batch-contract");
    expect(prompt).toContain("explicitly authorized a backward-compatible public API contract extension");
    expect(prompt.indexOf("## Governed retry context")).toBeGreaterThan(prompt.indexOf("Implement the batch upload handler"));
  });

  test("preserves issue-authored contract headings without adding runner contracts", async () => {
    const prompt = await promptFor({
      description: [
        "## Target outcome",
        "Keep the existing target text.",
        "## Required evidence",
        "Use the issue-specific verification.",
        "## Constraints / non-goals",
        "Stay inside this issue.",
        "## Stop policy / escalation",
        "Report blockers."
      ].join("\n"),
      title: "custom contract"
    });

    expect(prompt).toContain("## Target outcome");
    expect(prompt).not.toContain("## Goal Contract");
    expect(prompt).not.toContain("Deliver the requested end state");
    expect(prompt).not.toContain("## Runner lifecycle contract");
    expect(prompt).toContain("## Xuanwu execution context (authoritative)");
    expect(prompt).toContain("## Stop policy / escalation\nReport blockers.");
  });

  test("treats pre-dispatch triage wording as non-conflicting while preserving substantive gates", async () => {
    const prompt = await promptFor({
      description: ["## 前置门禁", "- 本 Issue 保持 triage，不要自动入队。", "- 必须等待用户提供真实账号认证方式。"].join("\n"),
      title: "Qoder final acceptance"
    });

    expect(prompt).toContain("本 Issue 保持 triage，不要自动入队");
    expect(prompt).toContain("already claimed Issue #1");
    expect(prompt).toContain("is not a reason to undo this active Run");
    expect(prompt).toContain("credentials, budget, external authorization, or user-supplied choices");
    expect(prompt).toContain("RUNNER_OUTCOME: needs_user | <reason>");
  });

  test("idles safely when there are no todo issues", async () => {
    const db = await openFixtureDatabase();
    const provider = new ScriptedProvider();
    addProject(db, "demo", provider.id);
    addIssue(db, "demo", "triage", { status: "triage" });

    expect(await runOnce(db, provider)).toEqual({ claimed: false });
    expect(provider.inputs).toEqual([]);
  });

  test("does not claim another todo for the same project while an executor run is still open", async () => {
    const db = await openFixtureDatabase();
    const provider = new ScriptedProvider();
    addProject(db, "demo", provider.id);
    const running = addIssue(db, "demo", "running", { status: "in_progress" });
    const waiting = addIssue(db, "demo", "waiting");
    insertOpenRun(db, running);

    expect(await runOnce(db, provider)).toEqual({ claimed: false });
    expect(provider.inputs).toEqual([]);
    expect(getIssue(db, waiting)).toMatchObject({ status: "todo", attempt_count: 0 });
    expect(listIssueRuns(db, waiting)).toEqual([]);
  });

  test("claims a different project while an unrelated project run is open", async () => {
    const db = await openFixtureDatabase();
    const provider = new ScriptedProvider();
    addProject(db, "demo", provider.id);
    addProject(db, "other", provider.id);
    const running = addIssue(db, "demo", "running", { status: "in_progress" });
    const waiting = addIssue(db, "other", "waiting");
    insertOpenRun(db, running);

    expect(await runOnce(db, provider, "other")).toMatchObject({ claimed: true });
    expect(provider.inputs.map((input) => input.issueId)).toEqual([waiting]);
    expect(getIssue(db, waiting)).toMatchObject({ status: "in_progress", attempt_count: 1 });
  });

  test("auto-run loop starts one session and leaves remaining todos queued", async () => {
    const db = await openFixtureDatabase();
    const provider = new ScriptedProvider();
    addProject(db, "serial-demo", provider.id, { auto_run: 1 });
    const first = addIssue(db, "serial-demo", "first");
    const second = addIssue(db, "serial-demo", "second");

    startProjectLoop({ database: db, providers: { [provider.id]: provider } }, "serial-demo");
    await settle(() => provider.inputs.length === 1);
    await settle(() => !isProjectLoopActive("serial-demo"));

    expect(provider.inputs.map((input) => input.issueId)).toEqual([first]);
    expect(getIssue(db, first)).toMatchObject({ status: "in_progress", attempt_count: 1 });
    expect(getIssue(db, second)).toMatchObject({ status: "todo", attempt_count: 0 });
    expect(listIssueRuns(db, second)).toEqual([]);
  });

  test("an asynchronous terminal event keeps the project locked until PI decides", async () => {
    const db = await openFixtureDatabase();
    const provider = new ScriptedProvider(FAKE, { events: [TURN_STARTED] });
    addProject(db, "deferred-demo", provider.id, { auto_run: 1 });
    const first = addIssue(db, "deferred-demo", "first");
    const second = addIssue(db, "deferred-demo", "second");

    startProjectLoop({ database: db, providers: { [provider.id]: provider } }, "deferred-demo");
    await settle(() => provider.inputs.length === 1);
    await settle(() => !isProjectLoopActive("deferred-demo"));

    provider.emit(first, DONE);
    await settle(() => listIssueRuns(db, first).at(-1)?.ended_at !== "");
    await Bun.sleep(20);

    expect(provider.inputs.map((input) => input.issueId)).toEqual([first]);
    expect(getIssue(db, first)).toMatchObject({ status: "in_progress" });
    expect(getIssue(db, second)).toMatchObject({ status: "todo" });
    expect(listIssueEvents(db, first, { types: ["issue.pi_acceptance_requested.v1"] })).toHaveLength(1);
  });
}
