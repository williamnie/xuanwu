import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../../db/database.ts";
import { createIssue } from "../../db/repositories/issueCreate.ts";
import { listIssueEvents, recordIssueEvent } from "../../db/repositories/issueEvents.ts";
import { insertIssueRunRecord } from "../../db/repositories/issueRuns.ts";
import { listIssueRuns } from "../../db/repositories/issues.ts";
import { prepareReservedIssueRun } from "../run/runPreparation.ts";
import { buildIssueCompletionCard, recordCompletionGitObservation, recordIssueCompletionCard } from "./completionCard.ts";

/** 合成同 Work 多 Run；数据库放在仓库外，命令观察不代表执行了真实测试。 */
export async function evidenceReuseFixture() {
  const root = await mkdtemp(join(tmpdir(), "xw-evidence-reuse-"));
  const cwd = join(root, "repo");
  await mkdir(cwd);
  const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  await writeFile(join(cwd, "input.txt"), "original input\n");
  git("add", "input.txt");
  git("commit", "-m", "fixture");
  const db = await openDatabase({ stateDir: join(root, "state") });
  db.sqlite.run("insert into projects (id,name,cwd,created_at,updated_at) values ('reuse','Reuse',?,?,?)",
    [cwd, new Date().toISOString(), new Date().toISOString()]);
  db.sqlite.run("insert into project_pi_settings (project_id,created_at,updated_at) values ('reuse',?,?)",
    [new Date().toISOString(), new Date().toISOString()]);
  const issue = createIssue(db, { project_id: "reuse", title: "补齐调查报告", description: "用本地输入验证行为", status: "in_progress" });
  async function run(commands: Array<{ command: string; exit: number }> = [], message = "报告已补全", during?: () => Promise<void>) {
    const prepared = await prepareReservedIssueRun(db, insertIssueRunRecord(db, issue.id));
    if (prepared.status !== "ready") throw new Error("fixture Run preparation failed");
    for (const [index, command] of commands.entries()) {
      recordIssueEvent(db, issue.id, "issue.log", {
        runtime_evidence_correlation: { issue_run_id: prepared.run.id },
        command: command.command,
        status: command.exit === 0 ? "completed" : "failed",
        payload: { schema_version: "xw.tool-observation.v1", representation: "terminal_tool_observation",
          cwd, exit_code: command.exit, item_id: `cmd-${index}`, duration_ms: 1, output_excerpt: "synthetic observation" }
      });
    }
    await during?.();
    recordIssueEvent(db, issue.id, "issue.log", { runtime_evidence_correlation: { issue_run_id: prepared.run.id }, text: message });
    db.sqlite.run("update issue_runs set status='succeeded', ended_at=? where id=?", [new Date().toISOString(), prepared.run.id]);
    const ended = listIssueRuns(db, issue.id).at(-1)!;
    await recordCompletionGitObservation(db, { issue_id: issue.id, repository: cwd, observed_at: ended.ended_at, run: ended });
    recordIssueEvent(db, issue.id, "issue.pi_acceptance_requested.v1", { issue_run_id: ended.id });
    const card = await buildIssueCompletionCard(db, issue.id);
    recordIssueCompletionCard(db, card, "fixture");
    return card;
  }
  function bindGitHub(stage: "investigate" | "repair" = "investigate") {
    db.sqlite.run(`insert into github_issue_cases (issue_node_id,repository_id,repository,issue_number,project_id,
      source_fingerprint,source_json,external_updated_at,external_state,issue_id,work_source_revision,stage,created_at,updated_at)
      values ('fixture',1,'fixture/repo',1,'reuse','fingerprint','{}',?,'open',?,1,?,?,?)`,
    [new Date().toISOString(), issue.id, stage, new Date().toISOString(), new Date().toISOString()]);
  }
  return { db, cwd, issue, git, run, bindGitHub, events: () => listIssueEvents(db, issue.id),
    close: async () => { db.close(); await rm(root, { recursive: true, force: true }); } };
}

export function reuseReport(stage: "investigate" | "repair" = "investigate") {
  return `XUANWU_GITHUB_REPORT: ${JSON.stringify({ source_revision: 1, stage,
    result: stage === "repair" ? "fixed" : "bug", summary: "合成调查", expected_basis: ["input.txt"],
    reproduction: { status: "reproduced", steps: ["bun test"], expected: "pass", actual: "observed" },
    evidence_commands: ["bun test"], regression_commands: stage === "repair" ? ["bun test"] : [] })}`;
}
