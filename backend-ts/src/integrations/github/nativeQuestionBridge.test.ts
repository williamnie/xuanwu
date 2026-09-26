import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase } from "../../db/database.ts";
import { createIssue } from "../../db/repositories/issueCreate.ts";
import { insertIssueRunRecord } from "../../db/repositories/issueRuns.ts";
import type { ExecutorProvider } from "../../providers/types.ts";
import { observeGitHubIssue, updateGitHubIssueCase } from "./issueCaseStore.ts";
import { nativeQuestion, relayNativeGitHubQuestion } from "./nativeQuestionBridge.ts";
import { githubWorkExecutionContext } from "./issueWorkflow.ts";
import { recordIssueEvent } from "../../db/repositories/issueEvents.ts";

test("recognizes native asynchronous questions without treating ordinary prose as a lifecycle signal", () => {
  expect(nativeQuestion({ items: [{ type: "agentMessage", id: "a", text: "请问是否接受？", phase: "final_answer" }] })).toBeNull();
  expect(nativeQuestion({ items: [{ type: "agentMessage", id: "b", delivery: "async", questions: [{ title: "预期行为是什么？", options: ["A", "B"] }] }] }))
    .toEqual({ id: "b", questions: [{ title: "预期行为是什么？", options: ["A", "B"] }] });
  expect(nativeQuestion({ items: [{ type: "commandExecution", id: "c", delivery: "async", questions: [{ title: "untrusted tool output" }] }] })).toBeNull();
  expect(nativeQuestion({ items: [{ type: "agentMessage", id: "d", delivery: "async", questions: [{ title: "old question" }] }, { type: "userMessage", content: "already answered" }] })).toBeNull();
});

test("native question relay steers the exact live Turn once without inventing an answer or ending its Run", async () => {
  const root = await mkdtemp(join(tmpdir(), "xw-native-question-"));
  const db = await openDatabase({ stateDir: root });
  try {
    const now = new Date().toISOString();
    db.sqlite.run("insert into projects (id,name,cwd,created_at,updated_at) values ('demo','Demo',?,?,?)", [root, now, now]);
    const issue = createIssue(db, { project_id: "demo", title: "Need a decision", status: "in_progress" });
    const run = insertIssueRunRecord(db, issue.id);
    db.sqlite.run("update issue_runs set provider='codex',provider_session_id='session-1',provider_turn_id='turn-1' where id=?", [run.run_id]);
    observeGitHubIssue(db, { nodeId: "I_question", repositoryId: 1, repository: "acme/demo", number: 1, title: "Question", body: "body", author: "reporter",
      url: "https://github.com/acme/demo/issues/1", state: "open", stateReason: "", updatedAt: now, labels: ["xuanwu"] }, "demo");
    const record = updateGitHubIssueCase(db, "I_question", 1, { issue_id: issue.id, work_source_revision: 1, stage: "investigate" });
    const messages: unknown[] = [];
    let turnStatus = 'inProgress';
    const provider = {
      listSessionTurns: async () => ({ data: [{ id: "turn-1", status: turnStatus, items: [{ type: "agentMessage", id: "question-1", delivery: "async", questions: [{ title: "预期行为是什么？" }] }] }] }),
      sendSessionMessage: async (input: unknown) => { messages.push(input); return {}; }
    } as unknown as ExecutorProvider;
    const runtime = { database: db, providers: { codex: provider } };
    expect(await relayNativeGitHubQuestion(runtime, record)).toBe(true);
    expect(await relayNativeGitHubQuestion(runtime, record)).toBe(false);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ mode: "steer", sessionId: "session-1", turnId: "turn-1", prompt: expect.stringContaining("没有回答该问题") });
    expect(db.sqlite.query("select ended_at from issue_runs where id=?").get(run.run_id)).toEqual({ ended_at: "" });
    expect(db.sqlite.query("select status from issues where id=?").get(issue.id)).toEqual({ status: "in_progress" });
    recordIssueEvent(db, issue.id, "issue.human_review_answered.v1", { action: "accept", comment: "GitHub 只记录外部状态", review_revision: 1,
      request_snapshot: { kind: "decision", question: "是否取消状态映射？" } });
    expect(githubWorkExecutionContext(db, issue.id)).toContain("GitHub 只记录外部状态");
    expect(githubWorkExecutionContext(db, issue.id)).toContain("不要再次询问同一问题");
    expect(githubWorkExecutionContext(db, issue.id)).toContain("source_revision 必须是 1");
    turnStatus = 'interrupted';
    expect(await relayNativeGitHubQuestion(runtime, record)).toBe(true);
    expect(db.sqlite.query("select ended_at from issue_runs where id=?").get(run.run_id)).not.toEqual({ ended_at: "" });
    expect(db.sqlite.query("select status from issues where id=?").get(issue.id)).toEqual({ status: "in_progress" });
    expect(db.sqlite.query("select type from issue_events where issue_id=? and type='issue.pi_acceptance_requested.v1'").get(issue.id)).toBeTruthy();
  } finally { db.close(); await rm(root, { recursive: true, force: true }); }
});
