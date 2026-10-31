import { setMemoryReflectionEnabled } from "../pi/memory/memoryReflectionQueue.ts";
import { evidenceReuseFixture, reuseReport } from "../domain/acceptance/evidenceReuseTestSupport.ts";
import { EXECUTION_EVIDENCE_REVOKED_EVENT } from "../domain/acceptance/priorExecutionEvidence.ts";
import { writeFile } from "node:fs/promises";
import { githubWorkAcceptanceProblem } from "../integrations/github/issueWorkflow.ts";
import { seedMemoryExperience } from "../pi/memory/memoryExperienceTestFixtures.ts";
import { expect, test } from "bun:test";

import { join } from "node:path";

import { recordIssueEvent } from "../db/repositories/issueEvents.ts";

import { getIssue, listIssueRuns } from "../db/repositories/issues.ts";

import { buildIssueCompletionCard } from "../domain/acceptance/completionCard.ts";
import { readIssueDecisionProjection, reviewHumanIssue } from "../domain/review/humanReview.ts";

import { diagnoseIssueState } from "../pi/issues/issueStateManager.ts";

import { applyPiAcceptanceDecision } from "./piAcceptanceApplication.ts";
import { observeGitHubIssue, updateGitHubIssueCase } from "../integrations/github/issueCaseStore.ts";

import { ContinuingProvider, fixture, completedIssue, decision } from "./piAcceptanceApplicationTestFixtures.ts";

export function registerPiAcceptanceApplicationOutcomesCases() {
  for (const stage of ["investigate", "repair"] as const) test(`accepts ${stage} report corrections using matched prior commands`, async () => {
    const f = await evidenceReuseFixture();
    try {
      f.bindGitHub(stage);
      await f.run([{ command: "bun test", exit: 0 }], "missing report fields");
      const card = await f.run([], reuseReport(stage));
      expect((await applyPiAcceptanceDecision({ database: f.db }, card, decision("accept"))).status).toBe("done");
      expect(listIssueRuns(f.db, f.issue.id)).toHaveLength(2);
      expect(f.db.sqlite.query("select count(*) n from pi_memory_items").get()).toEqual({ n: 0 });
    } finally { await f.close(); }
  });

  for (const change of ["workspace", "revocation"] as const) test(`rejects a formerly reusable card after ${change}`, async () => {
    const f = await evidenceReuseFixture();
    try {
      const source = await f.run([{ command: "bun test", exit: 0 }]);
      const card = await f.run();
      expect(card.prior_evidence?.items[0]?.status).toBe("reusable");
      if (change === "workspace") await writeFile(join(f.cwd, "input.txt"), "changed after card");
      else recordIssueEvent(f.db, f.issue.id, EXECUTION_EVIDENCE_REVOKED_EVENT,
        { source_card_fingerprint: source.fingerprint, reason: "撤回错误输入的观察" });
      await expect(applyPiAcceptanceDecision({ database: f.db }, card, decision("accept"))).rejects.toThrow("Prior execution evidence changed");
      expect(getIssue(f.db, f.issue.id)?.status).toBe("in_progress");
      expect(f.events().some(event => event.type === "issue.pi_acceptance_applied.v1")).toBe(false);
    } finally { await f.close(); }
  });

  test("stale prior green cannot satisfy a repair report with no new command", async () => {
    const f = await evidenceReuseFixture();
    try {
      f.bindGitHub("repair");
      await f.run([{ command: "bun test", exit: 0 }]);
      await writeFile(join(f.cwd, "input.txt"), "new implementation");
      const card = await f.run([], reuseReport("repair"));
      expect((await applyPiAcceptanceDecision({ database: f.db }, card, decision("accept"))).status).not.toBe("done");
      expect(f.events().find(event => event.type === "github.acceptance_contract_failed.v1")?.payload).toContain("code_snapshot_changed");
    } finally { await f.close(); }
  });

  test("non-GitHub acceptance cannot cite an invalid source or label history as new progress", async () => {
    const f = await evidenceReuseFixture();
    try {
      const source = await f.run([{ command: "bun test", exit: 0 }]);
      const card = await f.run();
      const progress = decision("accept");
      progress.progress.evidence_refs = [`run:${source.run.id}`];
      await expect(applyPiAcceptanceDecision({ database: f.db }, card, progress)).rejects.toThrow("not current Run progress");
      recordIssueEvent(f.db, f.issue.id, EXECUTION_EVIDENCE_REVOKED_EVENT, { source_run_id: source.run.id, reason: "撤回" });
      const invalid = await buildIssueCompletionCard(f.db, f.issue.id);
      const accept = decision("accept");
      accept.evidence_refs = [`run:${source.run.id}`];
      await expect(applyPiAcceptanceDecision({ database: f.db }, invalid, accept)).rejects.toThrow("requires revalidation");
    } finally { await f.close(); }
  });

  test("fresh validation satisfies a changed snapshot without inheriting the old green", async () => {
    const f = await evidenceReuseFixture();
    try {
      f.bindGitHub("repair");
      await f.run([{ command: "bun test", exit: 0 }]);
      await writeFile(join(f.cwd, "input.txt"), "new code");
      const fresh = await f.run([{ command: "bun test", exit: 0 }], reuseReport("repair"));
      expect(fresh.prior_evidence?.items[0]?.status).toBe("revalidation_required");
      expect((await applyPiAcceptanceDecision({ database: f.db }, fresh, decision("accept"))).status).toBe("done");
    } finally { await f.close(); }
  });

  test("report reader rechecks revocation instead of trusting a stored reusable projection", async () => {
    const f = await evidenceReuseFixture();
    try {
      f.bindGitHub();
      const source = await f.run([{ command: "bun test", exit: 0 }]);
      const card = await f.run([], reuseReport());
      expect(githubWorkAcceptanceProblem(f.db, card)).toBe("");
      recordIssueEvent(f.db, f.issue.id, EXECUTION_EVIDENCE_REVOKED_EVENT, { source_run_id: source.run.id, reason: "输入错误" });
      expect(githubWorkAcceptanceProblem(f.db, card)).toContain("撤回记录已变化");
    } finally { await f.close(); }
  });

  test("a new human decision resets the GitHub report retry budget once without accepting an invalid report", async () => {
    const db = await fixture(); const provider = new ContinuingProvider();
    const issue = completedIssue(db, "GitHub report recovery");
    observeGitHubIssue(db, { nodeId: "I_report", repositoryId: 1, repository: "acme/demo", number: 1,
      title: "Broken report", body: "", author: "author", url: "https://github.com/acme/demo/issues/1", state: "open", stateReason: "", updatedAt: new Date().toISOString(), labels: ["xuanwu"] }, "demo");
    updateGitHubIssueCase(db, "I_report", 1, { issue_id: issue.id, work_source_revision: 1, stage: "repair" });
    for (const runID of ["old-1", "old-2"]) recordIssueEvent(db, issue.id, "github.acceptance_contract_failed.v1", { run_id: runID, problem: "invalid report" });
    const runtime = { database: db, providers: { codex: provider } };
    expect((await applyPiAcceptanceDecision(runtime, await buildIssueCompletionCard(db, issue.id), decision("accept"))).status).toBe("needs_user");
    expect(provider.inputs).toHaveLength(0);
    const request = readIssueDecisionProjection(db, issue.id).request!;
    await reviewHumanIssue(db, issue.id, { action: "accept", comment: "CI 限制已确认，请收尾本地验证并修正报告。", review_request_id: request.id, review_revision: request.revision });
    for (let i = 0; i < 2; i++) {
      expect((await applyPiAcceptanceDecision(runtime, await buildIssueCompletionCard(db, issue.id), decision("accept"))).status).toBe("in_progress");
    }
    expect(provider.inputs).toHaveLength(2);
    expect(provider.inputs[0]?.prompt).toContain("CI 限制已确认");
    expect(provider.inputs[0]?.prompt).toContain("reproduction.status 只能为 reproduced 或 not_reproduced");
    expect(provider.inputs[0]?.prompt).toContain("不能使用 verified_fixed");
    expect((await applyPiAcceptanceDecision(runtime, await buildIssueCompletionCard(db, issue.id), decision("accept"))).status).toBe("needs_user");
    expect(provider.inputs).toHaveLength(2);
    expect(getIssue(db, issue.id)?.status).not.toBe("done");
  });

  test("automatically persists one reflection for accepted evidence; request failure never rolls back done", async () => {
    const db = await fixture();
    const seed = seedMemoryExperience(db);
    setMemoryReflectionEnabled(db, "demo", true);
    db.sqlite.run("update issue_runs set status='succeeded', ended_at=? where id=?", [new Date().toISOString(), seed.legacyRunID]);
    recordIssueEvent(db, seed.issueID, "issue.pi_acceptance_requested.v1", { issue_run_id: seed.legacyRunID });
    const card = await buildIssueCompletionCard(db, seed.issueID);
    db.sqlite.run("create trigger reflection_storage_error before insert on pi_memory_reflections begin select raise(abort, 'storage unavailable'); end");
    expect((await applyPiAcceptanceDecision({ database: db }, card, decision("accept"))).status).toBe("done");
    db.sqlite.run("drop trigger reflection_storage_error");
    await applyPiAcceptanceDecision({ database: db }, card, decision("accept"));
    await applyPiAcceptanceDecision({ database: db }, card, decision("accept"));
    expect(db.sqlite.query("select status, attempts from pi_memory_reflections").all()).toEqual([{ status: "pending", attempts: 0 }]);
    expect(db.sqlite.query("select count(*) n from pi_memory_items").get()).toEqual({ n: 0 });
  });

  test("final failure persists a diagnostic reflection but needs_user does not", async () => {
    const db = await fixture();
    setMemoryReflectionEnabled(db, "demo", true);
    for (const outcome of ["failed", "needs_user"] as const) {
      const seed = seedMemoryExperience(db);
      db.sqlite.run("update issue_runs set status='failed', ended_at=? where id=?", [new Date().toISOString(), seed.legacyRunID]);
      recordIssueEvent(db, seed.issueID, "issue.pi_acceptance_requested.v1", { issue_run_id: seed.legacyRunID });
      const card = await buildIssueCompletionCard(db, seed.issueID);
      expect((await applyPiAcceptanceDecision({ database: db }, card, decision(outcome))).status).toBe(outcome);
    }
    const rows = db.sqlite.query<{ summary_json: string }, []>("select summary_json from pi_memory_reflections").all();
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]!.summary_json).outcome).toBe("failed");
  });

  test("accepts the exact current card, persists semantic acceptance, and is idempotent", async () => {
    const db = await fixture();
    const issue = completedIssue(db, "Accept delivery");
    const card = await buildIssueCompletionCard(db, issue.id);
    const first = await applyPiAcceptanceDecision({ database: db }, card, decision("accept"));
    const replay = await applyPiAcceptanceDecision({ database: db }, card, decision("accept"));

    expect(first.status).toBe("done");
    expect(replay.status).toBe("done");
    expect(db.sqlite.query<{ count: number }, [number]>(
      "select count(*) as count from issue_events where issue_id=? and type='issue.pi_acceptance_applied.v1'"
    ).get(issue.id)?.count).toBe(1);
    expect(diagnoseIssueState(db, { includeDoneIssues: true, issueIDs: [issue.id] }).diagnostics).toEqual([]);
  });

  test("acceptance depends on PI's Session judgment, not Handoff artifacts", async () => {
    const db = await fixture();
    const issue = completedIssue(db, "Required handoff");
    const card = await buildIssueCompletionCard(db, issue.id);

    const accepted = await applyPiAcceptanceDecision({ database: db }, card, decision("accept"));
    expect(accepted.status).toBe("done");
  });

  test("PI can hold the Issue for one explicit human decision", async () => {
    const db = await fixture();
    const issue = completedIssue(db, "Need product choice");
    const card = await buildIssueCompletionCard(db, issue.id);
    const updated = await applyPiAcceptanceDecision(
      { database: db },
      card,
      decision("needs_user", "请确认是否接受这个范围取舍。")
    );

    expect(updated.status).toBe("needs_user");
    expect(readIssueDecisionProjection(db, issue.id)).toMatchObject({
      owner: "human",
      phase: "human_review",
      request: { kind: "decision", question: "需要在原 Session 补充明确工作。" }
    });
  });
}
