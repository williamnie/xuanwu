import { afterEach, describe, expect, test } from "bun:test";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { createIssue } from "../db/repositories/issueCreate.ts";
import { recordIssueEvent } from "../db/repositories/issueEvents.ts";
import { createIssueRun } from "../db/repositories/issueRuns.ts";
import { buildIssueCompletionCard } from "../domain/acceptance/completionCard.ts";
import { buildIssuePromptForTest } from "../runner/projectLoop.ts";
import { runPiIssueAcceptance } from "./issueAcceptance.ts";
import { cleanupDecisionFixtures, openDecisionFixture } from "./issueSupervisorDecisionTestSupport.ts";

afterEach(cleanupDecisionFixtures);

const goal975 = [
  "## 一句话目标",
  "满足可验证安全条件的等待任务可以释放目录，恢复时重新核对工作区。",
  "## 做什么",
  "- 执行分类：后续待办，本批次只建 Issue，不启动。",
  "## 不做什么",
  "- 后续待排期，本次不入队；不自动 stash/reset/commit，不新建 worktree。",
  "## 验收标准",
  "- 只读等待不无谓阻塞安全工作；持有改动的任务继续保护目录。"
].join("\n");

// 复现 #975 的两次输入，并保留真正的只读/付费门禁反例。
// Faux Provider 只检查真实运行时收到的上下文，不将预置响应冒充模型判断。
describe("Issue execution authority reaches PI acceptance", () => {
  for (const scenario of [
    { name: "implemented #975 with stale planning wording", goal: goal975,
      final: "已实现安全释放与恢复复核，28 项矩阵通过。RUNNER_OUTCOME: completed" },
    { name: "#975 rollback is still judged against its original feature goal", goal: goal975,
      final: "已按 PI 要求撤销全部实现，恢复12个文件、删除4个新增文件，工作区干净。RUNNER_OUTCOME: completed" },
    { name: "dispatch does not erase substantive read-only and paid-operation constraints",
      goal: "只读评估，不修改代码。真实模型付费测试及部署必须等待用户提供凭据、预算和授权。",
      final: "尚未取得付费授权，未修改代码或调用真实模型。RUNNER_OUTCOME: needs_user | 缺少预算和凭据" }
  ]) {
    test(scenario.name, async () => {
      const f = await openDecisionFixture("issue-execution-authority-");
      const faux = registerFauxProvider({ api: "pi-supervisor-api", provider: "pi-supervisor" });
      try {
        const issue = createIssue(f.db, { project_id: "demo", status: "in_progress",
          title: "安全释放等待任务工作目录", description: scenario.goal });
        const run = createIssueRun(f.db, issue.id);
        recordIssueEvent(f.db, issue.id, "issue.log", {
          runtime_evidence_correlation: { issue_run_id: run.id }, text: scenario.final
        });
        f.db.sqlite.run("update issue_runs set status='succeeded', ended_at=? where id=?",
          [new Date().toISOString(), run.id]);
        const card = await buildIssueCompletionCard(f.db, issue.id);
        expect(card.issue.goal).toBe(scenario.goal);
        expect(card.final_message).toBe(scenario.final);
        let acceptanceInput = "";
        faux.setResponses([(context) => {
          acceptanceInput = JSON.stringify(context);
          return fauxAssistantMessage(JSON.stringify({ decision: "needs_user", confidence: "high",
            rationale: "仅验证提示传递的离线替身", evidence_refs: [], unmet_requirements: ["fixture"],
            progress: { made_progress: false, evidence_refs: [], summary: "fixture" } }));
        }]);
        expect((await runPiIssueAcceptance({ ...f, database: f.db, card })).valid).toBe(true);
        const executionInput = buildIssuePromptForTest(f.project, issue, f.db);
        for (const rule of [
          "pre-dispatch planning state and is not a reason to undo this active Run",
          "credentials, budget, external authorization, or user-supplied choices",
          "PI follow-up instructions do not replace the original Issue goal",
          "A successful rollback or a clean workspace alone does not satisfy a feature implementation goal",
          "If substantive authorization is genuinely ambiguous, preserve the workspace and request a human decision"
        ]) {
          expect(executionInput).toContain(rule);
          expect(acceptanceInput).toContain(rule);
        }
        // 原始正文及本 Run 事实必须完整传递，不能靠删掉限制消除冲突。
        for (const fact of [scenario.goal, scenario.final]) {
          expect(acceptanceInput).toContain(JSON.stringify(fact).slice(1, -1).replaceAll("\\", "\\\\"));
        }
      } finally { faux.unregister(); f.db.close(); }
    });
  }
});
