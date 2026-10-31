import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { getAgentSession } from "../db/repositories/agentSessions.ts";
import { getIssue, listIssueRuns } from "../db/repositories/issues.ts";
import { listIssueEvents } from "../db/repositories/issueEvents.ts";
import { listNotifications } from "../db/repositories/notifications.ts";
import { listPiGuardianAlerts } from "../db/repositories/pi.ts";
import { runProjectLoopOnce } from "./projectLoop.ts";

import { FIXTURE_TIME, insertRow } from "../testing/harness.ts";
import {
  TURN_STARTED,
  FAKE,
  ScriptedProvider,
  openFixtureDatabase,
  addProject,
  addIssue,
  insertAgentProfile,
  runOnce,
  resolvedSettings,
  latestRunMetadata,
  latestRun,
  latestAttempt,
  closeClaimedIssue,
  latestEventPayload
} from "./projectLoopTestFixtures.ts";

export function registerProjectLoopProfilesCases() {
  test("routes an executor needs_user claim through PI semantic acceptance instead of failing immediately", async () => {
    const db = await openFixtureDatabase();
    const provider = new ScriptedProvider(FAKE, {
      events: [{ type: "provider.message", text: "已完成环境检查。\nRUNNER_OUTCOME: needs_user | 缺少部署凭证" }]
    });
    addProject(db, "demo", provider.id);
    const issueId = addIssue(db, "demo", "needs credentials");

    await runOnce(db, provider);

    expect(getIssue(db, issueId)).toMatchObject({ status: "in_progress", error: "" });
    expect(listIssueRuns(db, issueId).at(-1)).toMatchObject({ status: "failed", ended_at: expect.stringMatching(/Z$/) });
    expect(listPiGuardianAlerts(db, { projectId: "demo", status: "open" }).filter((alert) => alert.issue_id === issueId)).toHaveLength(0);
    expect(listNotifications(db, { projectID: "demo" }).filter((notification) => notification.issue_id === issueId)).toHaveLength(0);
    expect(listIssueEvents(db, issueId, { types: ["issue.pi_acceptance_requested.v1"] })).toHaveLength(1);
  });

  test("uses assigned executor profile for provider options and session linkage", async () => {
    const db = await openFixtureDatabase();
    const provider = new ScriptedProvider();
    addProject(db, "demo", provider.id);
    insertAgentProfile(db, "executor-fake", provider.id, { model: "profile-model" });
    const issueId = addIssue(db, "demo", "profile selected", { agent_profile_id: "executor-fake" });

    await runOnce(db, provider);

    expect(provider.inputs[0]).toMatchObject({
      approvalPolicy: "on-request", model: "profile-model", reasoningEffort: "high", sandbox: "danger-full-access"
    });
    expect(latestRun(db, issueId)).toMatchObject({
      agent_profile_id: "executor-fake",
      capability_summary: "issue_execution",
      selection_reason: "issue assigned agent_profile_id"
    });
    expect(getAgentSession(db, `fake-execution-only:fake-session-${issueId}`)).toMatchObject({
      agent_role: "executor",
      issue_id: issueId
    });
  });

  test("passes an assigned provider profile's empty model through to execution", async () => {
    const db = await openFixtureDatabase();
    const provider = new ScriptedProvider();
    addProject(db, "demo", provider.id);
    insertAgentProfile(db, "provider-default", provider.id, { model: "" });
    const issueId = addIssue(db, "demo", "use provider default model", { agent_profile_id: "provider-default" });

    await runOnce(db, provider);

    expect(provider.inputs[0]).toMatchObject({ issueId, model: "" });
  });

  test("freezes different Codex and Claude Work providers into Run and Attempt history", async () => {
    const db = await openFixtureDatabase();
    const providers = { codex: new ScriptedProvider("codex", { events: [TURN_STARTED] }), claude: new ScriptedProvider("claude", { events: [TURN_STARTED] }) };
    addProject(db, "demo", "codex");
    insertAgentProfile(db, "codex-work", "codex", { model: "gpt-5.6" });
    insertAgentProfile(db, "claude-work", "claude", { model: "claude-sonnet" });
    const codexIssue = addIssue(db, "demo", "Codex Work", { agent_profile_id: "codex-work", priority: 10 });
    const claudeIssue = addIssue(db, "demo", "Claude Work", { agent_profile_id: "claude-work", priority: 5 });

    await runProjectLoopOnce({ database: db, projectId: "demo", providers });
    closeClaimedIssue(db, codexIssue);
    db.sqlite.run("update projects set provider='claude', default_agent_profile_id='claude-work' where id='demo'");
    await runProjectLoopOnce({ database: db, projectId: "demo", providers });

    for (const [name, issueID] of [["codex", codexIssue], ["claude", claudeIssue]] as const) {
      expect(providers[name].inputs.map((input) => input.issueId)).toEqual([issueID]);
      expect(listIssueRuns(db, issueID).at(-1)).toMatchObject({
        agent_profile_id: `${name}-work`,
        provider: name,
        provider_session_id: `${name}-session-${issueID}`
      });
      expect(latestAttempt(db, issueID)).toMatchObject({ provider: name, provider_session_id: `${name}-session-${issueID}` });
    }
  });

  test("routes Qoder project defaults and Issue overrides in both directions with resolved settings", async () => {
    const db = await openFixtureDatabase();
    const providers = { codex: new ScriptedProvider("codex", { events: [TURN_STARTED] }), qoder: new ScriptedProvider("qoder", { events: [TURN_STARTED] }) };
    insertAgentProfile(db, "codex-work", "codex", { model: "gpt-5.6" });
    insertAgentProfile(db, "qoder-work", "qoder", { model: "performance" });
    addProject(db, "demo", "codex", { default_agent_profile_id: "qoder-work" });
    const codexOverride = addIssue(db, "demo", "Codex overrides Qoder project default", { agent_profile_id: "codex-work", priority: 10 });
    const qoderInherited = addIssue(db, "demo", "Qoder project default", { priority: 5 });

    await runProjectLoopOnce({ database: db, projectId: "demo", providers });
    closeClaimedIssue(db, codexOverride);
    await runProjectLoopOnce({ database: db, projectId: "demo", providers });
    closeClaimedIssue(db, qoderInherited);

    db.sqlite.run("update projects set default_agent_profile_id='codex-work' where id='demo'");
    const qoderOverride = addIssue(db, "demo", "Qoder overrides Codex project default", { agent_profile_id: "qoder-work" });
    await runProjectLoopOnce({ database: db, projectId: "demo", providers });

    expect(providers.codex.inputs.map((input) => input.issueId)).toEqual([codexOverride]);
    expect(providers.qoder.inputs.map((input) => input.issueId)).toEqual([qoderInherited, qoderOverride]);
    for (const [issueID, provider, reason] of [
      [codexOverride, "codex", "issue assigned agent_profile_id"],
      [qoderInherited, "qoder", "project default_agent_profile_id"],
      [qoderOverride, "qoder", "issue assigned agent_profile_id"]
    ] as const) {
      expect(listIssueRuns(db, issueID).at(-1)).toMatchObject({
        agent_profile_id: `${provider}-work`, provider, selection_reason: reason
      });
    }
    expect(latestRunMetadata(db, qoderOverride)).toMatchObject({
      resolved_settings: resolvedSettings({ approval_policy: "on-request", model: "performance", reasoning_effort: "high", sandbox: "danger-full-access" })
    });
  });

  test("keeps a historical Qoder profile fail-closed when Qoder runtime is unavailable", async () => {
    const db = await openFixtureDatabase();
    const codex = new ScriptedProvider("codex", { events: [TURN_STARTED] });
    insertAgentProfile(db, "qoder-work", "qoder", { model: "performance" });
    addProject(db, "demo", "codex", { default_agent_profile_id: "qoder-work" });
    const issueID = addIssue(db, "demo", "Historical Qoder selection");

    await runOnce(db, codex);

    expect(codex.inputs).toEqual([]);
    expect(getIssue(db, issueID)).toMatchObject({ status: "todo", attempt_count: 0 });
    expect(listIssueRuns(db, issueID)).toEqual([]);
    expect(latestEventPayload(db, issueID, "issue.runner_scope_decision")).toMatchObject({
      authority: "runner.providers", decision: "stop", provider: "qoder", reason: "provider_runtime", scope: "provider:qoder"
    });
  });

  test("resolves issue, profile, and project service tier before provider execution", async () => {
    const db = await openFixtureDatabase();
    const provider = new ScriptedProvider();
    addProject(db, "demo", provider.id, { default_service_tier: "project-fast" });
    const projectIssue = addIssue(db, "demo", "project speed", { priority: 6 });

    await runOnce(db, provider);
    closeClaimedIssue(db, projectIssue);

    insertAgentProfile(db, "executor-fake", provider.id, { model: "profile-model", service_tier: "profile-fast" });
    const profileIssue = addIssue(db, "demo", "profile speed", { agent_profile_id: "executor-fake", priority: 4 });
    const issueOverride = addIssue(db, "demo", "issue speed", { priority: 5, service_tier: "priority" });

    await runOnce(db, provider);
    closeClaimedIssue(db, issueOverride);
    await runOnce(db, provider);

    expect(provider.inputs.map(({ issueId, serviceTier, serviceTierSource }) => ({ issueId, serviceTier, serviceTierSource }))).toEqual([
      { issueId: projectIssue, serviceTier: "project-fast", serviceTierSource: "project" },
      { issueId: issueOverride, serviceTier: "priority", serviceTierSource: "issue" },
      { issueId: profileIssue, serviceTier: "profile-fast", serviceTierSource: "agent_profile" }
    ]);
    for (const [issueID, service_tier, service_tier_source, profile] of [
      [profileIssue, "profile-fast", "agent_profile", { approval_policy: "on-request", model: "profile-model", reasoning_effort: "high", sandbox: "danger-full-access" }],
      [issueOverride, "priority", "issue", {}],
      [projectIssue, "project-fast", "project", {}]
    ] as const) {
      expect(latestRunMetadata(db, issueID)).toEqual({
        run_id: `fake-run-${issueID}`,
        resolved_settings: resolvedSettings({ ...profile, service_tier, service_tier_source }),
        service_tier,
        service_tier_source
      });
    }
  });

  test("passes uploaded attachment images to executor provider as local images", async () => {
    const db = await openFixtureDatabase();
    const provider = new ScriptedProvider();
    addProject(db, "demo", provider.id);
    const imagePath = join(db.path, "..", "upload_issue_image.png");
    await writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    insertRow(db, "uploads", {
      id: "upload_issue_image", original_name: "shot.png", mime_type: "image/png", size_bytes: 4,
      sha256: "fixture-sha", storage_path: imagePath, created_at: FIXTURE_TIME
    });
    addIssue(db, "demo", "image issue", {
      description: `请按截图修复\n\n![shot](attachment://upload_issue_image)\n\n![dup](attachment://upload_issue_image)`
    });

    await runOnce(db, provider);

    expect(provider.inputs[0]?.images).toEqual([{ detail: "high", path: imagePath, type: "localImage" }]);
    expect(provider.inputs[0]?.prompt).toContain("attachment://upload_issue_image");
  });
}
