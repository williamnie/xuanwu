import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { evidenceReuseFixture } from "./evidenceReuseTestSupport.ts";
import { recordIssueEvent } from "../../db/repositories/issueEvents.ts";
import { buildIssueCompletionCard, completionCardFingerprint, recordIssueCompletionCard } from "./completionCard.ts";
import { EXECUTION_EVIDENCE_REVOKED_EVENT } from "./priorExecutionEvidence.ts";

test("report-only Run exposes verified prior observations without relabeling them current", async () => {
  const f = await evidenceReuseFixture();
  try {
    const source = await f.run([{ command: "bun test", exit: 0 }]);
    const report = await f.run();
    expect(report.commands.total).toBe(0);
    expect(report.prior_evidence?.items).toEqual([expect.objectContaining({
      source_run_id: source.run.id, source_card_fingerprint: source.fingerprint,
      status: "reusable", reasons: [], revalidation_commands: []
    })]);
  } finally { await f.close(); }
});

for (const change of ["input", "human_input", "environment", "unknown", "revoked", "commit", "untracked", "source_edit", "later_failure", "other_project", "other_work"] as const) {
  test(`prior evidence fails closed for ${change}`, async () => {
    const f = await evidenceReuseFixture();
    try {
      const source = await f.run([{ command: "bun test", exit: 0 }], "缺少报告字段",
        change === "source_edit" ? () => writeFile(join(f.cwd, "input.txt"), "edited after test") : undefined);
      if (change === "input") f.db.sqlite.run("update issues set description='different requirements' where id=?", [f.issue.id]);
      if (change === "human_input") recordIssueEvent(f.db, f.issue.id, "issue.comment", { body: "请改用新的输入条件" });
      if (change === "environment") f.db.sqlite.run("update projects set sandbox='different-environment' where id='reuse'");
      if (change === "unknown") f.db.sqlite.run("delete from issue_events where type='issue.execution_evidence_context.v1'");
      if (change === "revoked") recordIssueEvent(f.db, f.issue.id, EXECUTION_EVIDENCE_REVOKED_EVENT,
        { source_run_id: source.run.id, reason: "原始复现输入不完整" });
      if (change === "commit") f.git("commit", "--allow-empty", "-m", "new revision");
      if (change === "untracked") await writeFile(join(f.cwd, "new-input.txt"), "new input");
      if (change === "other_project" || change === "other_work") {
        const wrong = structuredClone(source);
        if (change === "other_project") wrong.issue.project_id = "other";
        else wrong.issue.id += 1;
        wrong.fingerprint = completionCardFingerprint(wrong);
        recordIssueEvent(f.db, f.issue.id, "issue.completion_card.v1", { card: wrong, fingerprint: wrong.fingerprint });
      }
      const report = await f.run(change === "later_failure" ? [{ command: "/bin/zsh -lc 'bun test'", exit: 1 }] : []);
      expect(report.prior_evidence?.items[0]?.status).toBe("revalidation_required");
      expect(report.prior_evidence?.items[0]?.revalidation_commands).toEqual(["bun test"]);
      const expected = { input: "inputs_changed", human_input: "inputs_changed", environment: "environment_changed", unknown: "execution_conditions_unavailable",
        revoked: "evidence_revoked:", commit: "code_snapshot_changed", untracked: "code_snapshot_changed",
        source_edit: "source_command_snapshot_unconfirmed", later_failure: "superseded_command_result",
        other_project: "source_work_or_run_mismatch", other_work: "source_work_or_run_mismatch" }[change];
      expect(report.prior_evidence?.items[0]?.reasons.some(reason => reason.startsWith(expected))).toBe(true);
    } finally { await f.close(); }
  });
}

test("repeated report-only Runs preserve the original source and failed reproduction observations", async () => {
  const f = await evidenceReuseFixture();
  try {
    const source = await f.run([{ command: "bun test", exit: 1 }]);
    await f.run();
    const report = await f.run();
    expect(report.prior_evidence?.items).toHaveLength(1);
    expect(report.prior_evidence?.items[0]).toMatchObject({ source_run_id: source.run.id, status: "reusable" });
    expect(report.prior_evidence?.items[0]?.commands[0]?.exit_code).toBe(1);
    recordIssueCompletionCard(f.db, report, "replay");
    expect((await buildIssueCompletionCard(f.db, f.issue.id)).fingerprint).toBe(report.fingerprint);
  } finally { await f.close(); }
});

test("tampered history cannot silently fall back to an older green card", async () => {
  const f = await evidenceReuseFixture();
  try {
    const source = await f.run([{ command: "bun test", exit: 0 }]);
    source.commands.items[0]!.exit_code = 1;
    recordIssueEvent(f.db, f.issue.id, "issue.completion_card.v1", { card: source, fingerprint: source.fingerprint });
    const current = await f.run();
    expect(current.prior_evidence?.items).toHaveLength(0);
    expect(current.prior_evidence?.unavailable_sources).toEqual([expect.objectContaining({
      reason: "source_card_invalid; inspect ledger and revalidate"
    })]);
  } finally { await f.close(); }
});

test("workspace changes after the terminal observation invalidate reuse at card build", async () => {
  const f = await evidenceReuseFixture();
  try {
    await f.run([{ command: "bun test", exit: 0 }]);
    await f.run();
    await writeFile(join(f.cwd, "input.txt"), "after terminal");
    const report = await buildIssueCompletionCard(f.db, f.issue.id);
    expect(report.prior_evidence?.items[0]?.reasons).toContain("code_snapshot_changed");
  } finally { await f.close(); }
});

test("changed input snapshot cannot inherit a prior green command", async () => {
  const f = await evidenceReuseFixture();
  try {
    await f.run([{ command: "bun test", exit: 0 }]);
    await writeFile(join(f.cwd, "input.txt"), "changed input\n");
    const report = await f.run();
    expect(report.prior_evidence?.items[0]).toMatchObject({
      status: "revalidation_required", reasons: expect.arrayContaining(["code_snapshot_changed"]), revalidation_commands: ["bun test"]
    });
  } finally { await f.close(); }
});
