import { expect, test } from "bun:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { listContextBundles } from "../../db/repositories/contextBundles.ts";
import { listIssues } from "../../db/repositories/issues.ts";
import { getPiConversation, listPiActions } from "../../db/repositories/pi.ts";
import { runPiConversationPrompt } from "./piConversationApi.ts";
import { getAgentSession } from "../../db/repositories/agentSessions.ts";
import { insertIssue, waitFor } from "../../testing/harness.ts";
import type { TestFixture } from "./piConversationMessagesApi.testFixture.ts";

export function registerManualContextToolReturnsACases(testScope: TestFixture) {
  const { piFixture, toolUse, actionEvents, firstActionEventPayload, sessionCwd, seedManualContextEvents, FakeExecutorProvider } = testScope;
  test("manual context tool returns a bundle for PI to interpret without hardcoded proposals", async () => {
      const { database, faux, open, ask } = await piFixture();
      const prompt = "看看刚刚群里的截图和消息，是个 bug，创建 issue";
      faux.setResponses([
        toolUse("manual_context_intake", { now: "2026-07-06T01:10:00Z", require_attachments: true, source: "fixture-im" }),
        fauxAssistantMessage("我已读取上下文；下一步由我根据 bundle 决定。")
      ]);
      seedManualContextEvents(database);
      await open("conv-manual-trigger", { project_id: "demo" });
  
      expect(await ask("conv-manual-trigger", prompt)).toMatchObject({ text: "我已读取上下文；下一步由我根据 bundle 决定。" });
      const bundle = listContextBundles(database, "fixture-im", 1)[0];
      expect(bundle).toMatchObject({ created_by: "user", source: "fixture-im", trigger: "manual" });
      expect(bundle.source_query).toMatchObject({
        attachment_kinds: ["image"],
        manual_trigger: { conversation_id: "conv-manual-trigger", source: "runner_chat", user_prompt: prompt }
      });
      expect(listPiActions(database).find((action) => action.action_type === "attention_inbox.domain_skill")).toBeUndefined();
      expect(listIssues(database, { projectId: "demo" })).toEqual([]);
    });
  
  test("Feishu PI conversation creates an issue, enqueues it, and starts executor session", async () => {
      const executor = new FakeExecutorProvider();
      const { database, faux, open, ask } = await piFixture({ executor });
      faux.setResponses([
        fauxAssistantMessage([
          fauxToolCall("issue_create_proposal", { description: "修复登录 bug", project_id: "demo", title: "Feishu task" }),
          fauxToolCall("issue_enqueue_proposal", { issue_id: 1, rationale: "Feishu task should start immediately" })
        ], { stopReason: "toolUse" }),
        fauxAssistantMessage("已创建 issue #1 并开始执行。")
      ]);
      await open("feishu-om-run", { project_id: "demo" });
  
      expect(await ask("feishu-om-run", "@PI 帮我在 demo 修复登录 bug")).toMatchObject({
        conversation_id: "feishu-om-run",
        status: "completed",
        text: "已创建 issue #1 并开始执行。"
      });
      const issues = listIssues(database, { projectId: "demo" });
      expect(issues).toMatchObject([{ project_id: "demo", status: "in_progress", title: "Feishu task" }]);
      await waitFor(() => executor.calls.length > 0);
      expect(executor.calls).toMatchObject([{ issueId: issues[0]?.id, projectId: "demo" }]);
    });
  
  test("Feishu runner chat can manage issues from another issue project without switching context", async () => {
      const executor = new FakeExecutorProvider();
      const { database, faux, open, ask } = await piFixture({ executor, projects: ["xuanwu", "movo-mobile"] });
      insertIssue(database, { id: 501, project_id: "movo-mobile", title: "Mobile issue" });
      faux.setResponses([
        toolUse("issue_enqueue_proposal", { issue_id: 501, rationale: "start named issue project task" }),
        fauxAssistantMessage("已开始 movo-mobile 的 #501。")
      ]);
      await open("feishu-cross-issue", { project_id: "xuanwu" });
  
      expect(await ask("feishu-cross-issue", "开始 movo-mobile 的 #501")).toMatchObject({
        conversation_id: "feishu-cross-issue",
        status: "completed",
        text: "已开始 movo-mobile 的 #501。"
      });
      const actions = listPiActions(database);
      expect(actions.filter((action) => action.status === "pending")).toEqual([]);
      expect(actions).toContainEqual(expect.objectContaining({
        action_type: "issue.enqueue",
        gate_decision: "execute",
        issue_id: 501,
        project_id: "movo-mobile",
        status: "completed"
      }));
      expect(listIssues(database, { projectId: "movo-mobile" })).toMatchObject([
        { id: 501, project_id: "movo-mobile", status: "in_progress" }
      ]);
      await waitFor(() => executor.calls.length > 0);
      expect(executor.calls).toMatchObject([{ issueId: 501, projectId: "movo-mobile" }]);
    });
  
  test("Feishu issue-id prompt targets a project without rebinding the IM conversation", async () => {
      const executor = new FakeExecutorProvider();
      const { database, faux, open } = await piFixture();
      insertIssue(database, { id: 386, project_id: "demo", title: "Explicit Feishu issue" });
      faux.setResponses([
        toolUse("issue_enqueue_proposal", { issue_id: 386, rationale: "Feishu asked to start this explicit issue" }),
        fauxAssistantMessage("已开始 #386。")
      ]);
      await open("feishu-global-before-issue", { title: "Feishu" });
  
      const result = await runPiConversationPrompt({ database, providers: { codex: executor } }, {
        conversationId: "feishu-global-before-issue",
        prompt: "开始 #386",
        targetProjectId: "demo",
        title: "Feishu"
      });
      await waitFor(() => executor.calls.length > 0);
  
      const actions = listPiActions(database);
      expect(result).toMatchObject({ conversation_id: "feishu-global-before-issue", text: "已开始 #386。" });
      expect(getPiConversation(database, "feishu-global-before-issue")).toMatchObject({ project_id: "" });
      expect(sessionCwd(database, "feishu-global-before-issue")).not.toBe("/tmp/demo");
      expect(actions.filter((action) => action.status === "pending")).toEqual([]);
      expect(actions).toMatchObject([{
        action_type: "issue.enqueue",
        gate_decision: "execute",
        issue_id: 386,
        project_id: "demo",
        status: "completed"
      }]);
      expect(listIssues(database, { projectId: "demo" })).toMatchObject([{ id: 386, project_id: "demo", status: "in_progress" }]);
      expect(executor.calls).toMatchObject([{ issueId: 386, projectId: "demo" }]);
    });
  
  test("Feishu global follow-up directly enqueues an Issue resolved from conversation semantics", async () => {
      const executor = new FakeExecutorProvider();
      const { database, faux, open, ask } = await piFixture({ executor });
      insertIssue(database, { id: 387, project_id: "demo", title: "Semantic target" });
      faux.setResponses([
        toolUse("issue_enqueue_proposal", { issue_id: 387, rationale: "resolved from the conversation history" }),
        fauxAssistantMessage("已开始执行 #387。")
      ]);
      await open("feishu-semantic-target", { title: "Feishu" });
  
      expect(await ask("feishu-semantic-target", "我已经改好了，开始吧"))
        .toMatchObject({ conversation_id: "feishu-semantic-target", text: "已开始执行 #387。" });
      expect(listPiActions(database).find((item) => item.action_type === "issue.enqueue")).toMatchObject({
        gate_decision: "execute",
        gate_reason: expect.stringContaining("scope matched runner issues"),
        issue_id: 387,
        project_id: "demo",
        status: "completed"
      });
      await waitFor(() => executor.calls.length > 0);
      expect(listIssues(database, { projectId: "demo" }).find((issue) => issue.id === 387)?.status).toBe("in_progress");
      expect(executor.calls).toMatchObject([{ issueId: 387, projectId: "demo" }]);
    });
  
  test("Feishu short retry reaches PI with its trusted Issue context and no intent router", async () => {
      const { database, faux } = await piFixture();
      insertIssue(database, { id: 774, project_id: "demo", title: "Retry context issue" });
      faux.setResponses([fauxAssistantMessage("我会先核对该 Work 的完成态，再决定是否需要重试。")]);
  
      const result = await runPiConversationPrompt({ database }, {
        conversationId: "feishu-retry-context",
        prompt: "重试吧",
        targetIssueId: 774,
        targetProjectId: "demo",
        title: "Feishu"
      });
  
      expect(result).toMatchObject({
        conversation_id: "feishu-retry-context",
        text: "我会先核对该 Work 的完成态，再决定是否需要重试。"
      });
      expect(actionEvents(database, "feishu-retry-context", "supervisor_intent_routed")).toEqual([]);
      expect(firstActionEventPayload(database, "feishu-retry-context", "supervisor_context_resolved")).toMatchObject({
        status: "resolved",
        target: { project_id: "demo", work_ids: ["xw:work:issues:774"] }
      });
      expect(listIssues(database, { projectId: "demo" })).toMatchObject([{ id: 774, status: "triage" }]);
    });
  
  test("Feishu IM one-shot project target scopes issue tools without switching runtime cwd", async () => {
      const { database, faux, open } = await piFixture({ projects: ["xuanwu", "demo", "other"] });
      insertIssue(database, { id: 700, project_id: "demo", title: "Demo issue" });
      insertIssue(database, { id: 701, project_id: "other", title: "Other issue" });
      faux.setResponses([toolUse("issue_status_summary", {}), fauxAssistantMessage("demo 当前有 1 个 triage issue。")]);
      await open("feishu-im-target-project", { project_id: "xuanwu", title: "Feishu" });
  
      const result = await runPiConversationPrompt({ database }, {
        clearProjectId: true,
        conversationId: "feishu-im-target-project",
        prompt: "demo 当前还有多少 issue",
        targetProjectId: "demo",
        title: "Feishu"
      });
  
      expect(result).toMatchObject({ conversation_id: "feishu-im-target-project", text: "demo 当前有 1 个 triage issue。" });
      expect(getPiConversation(database, "feishu-im-target-project")).toMatchObject({ project_id: "" });
      expect(getAgentSession(database, "pi-sdk:feishu-im-target-project")).toMatchObject({ project_id: "" });
      expect(["/tmp/demo", "/tmp/xuanwu"]).not.toContain(sessionCwd(database, "feishu-im-target-project"));
      expect(listPiActions(database).find((item) => item.action_type === "issue.status_summary"))
        .toMatchObject({ project_id: "demo", status: "completed" });
    });
  
  test("Feishu generic counts do not inherit the Project from the previous turn", async () => {
      const { database, faux } = await piFixture({ projects: ["demo", "other"] });
      insertIssue(database, { id: 710, project_id: "demo", title: "Demo issue" });
      insertIssue(database, { id: 711, project_id: "other", title: "Other issue" });
      faux.setResponses([
        toolUse("issue_status_summary", {}),
        fauxAssistantMessage("demo 有 1 个未完成 issue。"),
        toolUse("issue_status_summary", {}),
        fauxAssistantMessage("全局有 2 个未完成 issue。")
      ]);
      const feishu = { conversationId: "feishu-count-scope", title: "Feishu" };
  
      await runPiConversationPrompt({ database }, { ...feishu, prompt: "demo 还有多少 issue 没做", targetProjectId: "demo" });
      const second = await runPiConversationPrompt({ database }, { ...feishu, prompt: "还有多少 issue 没做" });
  
      const actions = listPiActions(database).filter((action) => action.action_type === "issue.status_summary");
      const scoped = (scope: string) => actions.find((action) => JSON.parse(action.payload_json).scope === scope);
      expect(second.text).toBe("全局有 2 个未完成 issue。");
      expect(actions).toHaveLength(2);
      expect(scoped("global")).toMatchObject({ project_id: "", status: "completed" });
      expect(scoped("project")).toMatchObject({ project_id: "demo", status: "completed" });
    });
}
