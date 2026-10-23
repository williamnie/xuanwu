import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { type RunnerDatabase } from "../../db/database.ts";
import { listContextBundles } from "../../db/repositories/contextBundles.ts";
import { createExternalEvent } from "../../db/repositories/externalEvents.ts";
import { listIssues } from "../../db/repositories/issues.ts";
import { getPiConversation, getPiIssueCompletionWatch, listPiActionEvents, listPiActions } from "../../db/repositories/pi.ts";
import type { ExecutorProvider, ProviderRunInput } from "../../providers/types.ts";
import { EventBus } from "../../events/bus.ts";
import { runPiConversationPrompt } from "./piConversationApi.ts";
import { finalPiConversationSseData, parsePiConversationSse, readPiConversationSse } from "./piConversationSse.testSupport.ts";
import { createDefaultRouter } from "../server.ts";
import { getAgentSession, upsertAgentSession } from "../../db/repositories/agentSessions.ts";
import { createIssueRun } from "../../db/repositories/issueRuns.ts";
import { readIssueDecisionProjection } from "../../domain/review/humanReview.ts";
import { listBuiltinAssistantTools } from "../../pi/tools/builtinToolRegistry.ts";
import { FIXTURE_TIME, insertIssue, insertProject, insertRow, useTestDatabase, waitFor } from "../../testing/harness.ts";
import { useFauxPi, type FauxPiOptions } from "../../testing/fauxPi.ts";

const BASE_URL = "http://127.0.0.1:3008";
const openFixtureDatabase = useTestDatabase();
const fauxPi = useFauxPi("pi-conversation");

describe("Bun PI conversation message API", () => {
  test("global chat invokes human acceptance and cross-project Work/Session reads through the real tool runtime", async () => {
    const { database, faux, open, ask } = await piFixture({ projects: ["target"] });
    insertIssue(database, { id: 967, project_id: "target", status: "needs_user" });
    const run = createIssueRun(database, 967);
    database.sqlite.run("update issue_runs set ended_at=?,status='needs_user' where id=?", [new Date().toISOString(), run.id]);
    upsertAgentSession(database, { provider: "codex", provider_session_id: "target-session", project_id: "target", issue_id: 967 });
    faux.setResponses([
      capabilityInvoke("session_read_summary", { session_key: "codex:target-session" }),
      capabilityInvoke("work_read", { work_id: "xw:work:issues:967" }),
      capabilityInvoke("human_review_request_create", { issue_id: 967, kind: "acceptance", question: "接受已人工核对的当前交付" }),
      () => {
        const review = readIssueDecisionProjection(database, 967).request;
        expect(review?.status).toBe("open");
        return capabilityInvoke("human_review_response", { issue_id: 967, action: "accept",
          review_request_id: review!.id, review_revision: review!.revision, comment: "用户已核对，停止追加校验" });
      },
      fauxAssistantMessage("人工确认已记录，等待收尾。")
    ]);
    await open("conv-global-acceptance");
    expect(await ask("conv-global-acceptance", "#967 我已人工核对完了，接受当前交付，直接完成并继续后面的任务"))
      .toMatchObject({ text: "人工确认已记录，等待收尾。" });
    const actions = listPiActions(database, { conversationId: "conv-global-acceptance" });
    for (const action_type of ["session.read_summary", "work.read", "human_review.request", "human_review.respond"]) {
      expect(actions).toContainEqual(expect.objectContaining({ action_type, status: "completed", gate_decision: "execute" }));
    }
    expect(actions.some(action => action.status === "denied" || action.status === "pending")).toBe(false);
    expect(readIssueDecisionProjection(database, 967)).toMatchObject({ owner: "pi", request: { status: "accepted", kind: "acceptance" } });
  });

  test("streams accepted and ordered assistant deltas before PI completion", async () => {
    const bus = new EventBus();
    const { faux, router, open, send, transcriptWith } = await piFixture({ bus, faux: { tokenSize: { min: 1, max: 1 } } });
    const providerGate = Promise.withResolvers<void>();
    let providerCompleted = false;
    faux.setResponses([async () => {
      await providerGate.promise;
      providerCompleted = true;
      return fauxAssistantMessage("pi reply");
    }]);
    const events = bus.subscribe();
    let partialDetailPromise: Promise<any> | undefined;
    const stopObserving = bus.observe((event) => {
      if (event.type === "pi.conversation.event" && event.agent_event_type === "message_update" && event.text) {
        partialDetailPromise ??= getJson(router, "/api/pi/conversations/conv-msg");
      }
    });

    const created = await open("conv-msg", { project_id: "demo" });
    await open("conv-idle", { project_id: "demo" });
    const message = await send("conv-msg", "hello");
    const reader = message.body!.getReader();
    const firstText = new TextDecoder().decode((await reader.read()).value);

    expect(created.status).toBe(201);
    expect(message.status).toBe(201);
    expect(message.headers.get("content-type")).toContain("text/event-stream");
    expect(firstText).toContain("event: accepted");
    expect(firstText).not.toContain("event: completed");
    expect(providerCompleted).toBe(false);
    const activeList = await getJson(router, "/api/pi/conversations");
    expect(activeList[0]).toMatchObject({ id: "conv-msg", runtime_status: "running" });
    expect(activeList[0]?.active_turn_id).toBeTruthy();
    expect(await getJson(router, "/api/pi/conversations/conv-msg")).toMatchObject({
      active_text: "",
      active_turn_id: activeList[0]?.active_turn_id,
      runtime_status: "running"
    });

    providerGate.resolve();
    let remainingText = "";
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
      remainingText += new TextDecoder().decode(chunk.value);
    }
    const turnEvents = parsePiConversationSse(`${firstText}${remainingText}`);
    const accepted = turnEvents.find((event) => event.event === "accepted");
    const deltas = turnEvents.filter((event) => event.event === "assistant_text_delta");
    const completed = turnEvents.find((event) => event.event === "completed");
    const partialDetail = await partialDetailPromise;
    stopObserving();
    expect(turnEvents.map((event) => event.event)).toContain("start");
    expect(deltas.length).toBeGreaterThan(1);
    expect(deltas.map((event) => event.data.delta).join("")).toBe("pi reply");
    expect(completed?.data).toMatchObject({
      conversation_id: "conv-msg",
      pi_session_id: "conv-msg",
      status: "completed",
      title: "hello",
      text: "pi reply",
      message_count: 2
    });
    expect(accepted?.data.turn_id).toBe(completed?.data.turn_id);
    expect(turnEvents.every((event) => event.id === accepted?.data.turn_id)).toBe(true);
    expect(partialDetail).toMatchObject({ runtime_status: "running" });
    expect(partialDetail.active_text.length).toBeGreaterThan(0);
    expect("pi reply".startsWith(partialDetail.active_text)).toBe(true);
    const firstEvent = await events.next();
    events.close();
    expect(firstEvent).toMatchObject({
      type: "pi.conversation.event",
      conversationId: "conv-msg",
      projectId: "demo",
      provider: "pi-sdk",
      turnId: accepted?.data.turn_id
    });
    expect(firstEvent?.issueId).toBeUndefined();
    expect(faux.state.callCount).toBe(1);
    const persisted = await transcriptWith("conv-msg", "pi reply");
    expect(persisted).toMatchObject({ active_text: "", active_turn_id: "", runtime_status: "idle" });
    expect(persisted.transcript).toEqual([
      expect.objectContaining({ role: "user", text: "hello" }),
      expect.objectContaining({ role: "assistant", text: "pi reply" })
    ]);
  });

  test("derives stable conversation title from markdown prompt", async () => {
    const { faux, open, ask } = await piFixture();
    faux.setResponses([fauxAssistantMessage("ok")]);
    await open("conv-title", { project_id: "demo", title: "New conversation" });
    expect(await ask("conv-title", "帮我看下 **Runner Markdown** 渲染"))
      .toMatchObject({ conversation_id: "conv-title", title: "帮我看下 Runner Markdown 渲染" });
  });

  test("lets PI choose a concrete tool without a pre-LLM intent route", async () => {
    const { database, faux, open, ask } = await piFixture();
    faux.setResponses([
      toolUse("issue_create_proposal", {
        description: "PI chose a concrete issue after reading the conversation",
        project_id: "demo",
        title: "PI-created issue"
      }),
      fauxAssistantMessage("已创建 issue。")
    ]);
    await open("conv-intent-route", { project_id: "demo" });

    expect(await ask("conv-intent-route", "在 demo 项目中处理一下")).toMatchObject({ text: "已创建 issue。" });
    const contextEvents = actionEvents(database, "conv-intent-route", "supervisor_context_resolved");
    expect(listIssues(database, { projectId: "demo" })).toContainEqual(expect.objectContaining({ title: "PI-created issue" }));
    expect(listPiActions(database).find((action) => action.action_type === "issue.create"))
      .toMatchObject({ gate_decision: "execute", status: "completed" });
    expect(actionEvents(database, "conv-intent-route", "supervisor_intent_routed")).toEqual([]);
    expect(contextEvents).toHaveLength(1);
    expect(JSON.parse(contextEvents[0]!.payload_json)).toMatchObject({
      status: "resolved",
      target: { project_id: "demo", work_ids: [] },
      candidates: [expect.objectContaining({
        project_id: "demo",
        sources: expect.arrayContaining([
          expect.objectContaining({ kind: "explicit_project" }),
          expect.objectContaining({ kind: "current_page" })
        ])
      })]
    });
    expect(contextEvents[0]?.payload_json).not.toContain("处理一下");
  });

  test("uses the tool-feedback loop to ask for Project after Issue creation reports missing context", async () => {
    const { database, faux, open, ask } = await piFixture({ projects: ["demo", "movo-web"] });
    faux.setResponses([
      toolUse("issue_create_proposal", { description: "修复登录 bug", title: "修复登录 bug" }),
      fauxAssistantMessage("这个 Issue 要创建在哪个项目？")
    ]);
    await open("conv-create-project-clarification");

    expect(await ask("conv-create-project-clarification", "创建个 Issue 修复登录 bug"))
      .toMatchObject({ text: "这个 Issue 要创建在哪个项目？" });
    const toolAudit = actionEvents(database, "conv-create-project-clarification", "tool_call_audit")
      .map((event) => JSON.parse(event.payload_json) as Record<string, any>)
      .find((event) => event.tool === "issue_create_proposal");
    expect(toolAudit).toMatchObject({
      error: { message: expect.stringContaining("issue_create_project_required"), type: "tool_error" },
      status: "failed",
      tool: "issue_create_proposal"
    });
    expect(listPiActions(database).some((action) => action.action_type === "issue.create")).toBe(false);
    expect(listIssues(database)).toEqual([]);
  });

  test("lets PI create a local project and write its PRD without starting coding Work", async () => {
    const { database, faux, open, ask } = await piFixture({ projects: [] });
    const projectRoot = join(database.path, "..", "fashion-studio");
    faux.setResponses([
      toolUse("project_create", { cwd: projectRoot, id: "fashion-studio", name: "Fashion Studio" }),
      toolUse("workspace_write_file", {
        content: "# Fashion Studio PRD\n\n## MVP\n服装模特图与首屏图。\n",
        path: "PRD.md",
        project_id: "fashion-studio"
      }),
      fauxAssistantMessage(`项目已创建，PRD 已写入 ${join(projectRoot, "PRD.md")}。`)
    ]);
    await open("conv-local-project");

    const result = await ask("conv-local-project", `请在 ${projectRoot} 新建项目，并根据当前对话把 PRD 写入 PRD.md`);
    expect(result.text).toContain("PRD 已写入");
    expect(readFileSync(join(projectRoot, "PRD.md"), "utf8")).toContain("服装模特图与首屏图");
    expect(getPiConversation(database, "conv-local-project")).toMatchObject({ project_id: "fashion-studio" });
    expect(listIssues(database, { projectId: "fashion-studio" })).toEqual([]);
    expect(listPiActions(database)).toEqual(expect.arrayContaining([
      expect.objectContaining({ action_type: "project.create", gate_decision: "execute", status: "completed" }),
      expect.objectContaining({ action_type: "workspace.write_file", gate_decision: "execute", status: "completed" })
    ]));
  });

  test("passes uploaded attachment images to PI SDK prompt", async () => {
    const { database, faux, open, ask } = await piFixture();
    faux.setResponses([(context) => fauxAssistantMessage(imageSummary(context))]);
    insertUpload(database, "upload_pi_image");
    await open("conv-image", { project_id: "demo" });

    expect(await ask("conv-image", "这张图有什么？\n\n![uploaded image](attachment://upload_pi_image)"))
      .toMatchObject({ text: `images=1; mime=image/png; bytes=${PNG_FIXTURE.byteLength}` });
  });

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

  test("derives Telegram runner-chat authority from connector projection instead of conversation id", async () => {
    const { database, faux } = await piFixture();
    insertIssue(database, { id: 720, project_id: "demo", title: "Telegram watch" });
    faux.setResponses([
      toolUse("issue_execution_status", { id: 720 }),
      toolUse("issue_completion_watch_create", {
        issue_ids: [720],
        project_id: "demo",
        target_channel: "feishu_runner_chat",
        target_chat_id: "oc_untrusted"
      }),
      fauxAssistantMessage("Telegram source confirmed.")
    ]);

    await runPiConversationPrompt({ database }, {
      channelContextProjection: {
        connectorID: "telegram",
        conversationID: "tg-chat-1",
        events: [],
        omittedCount: 0,
        piConversationID: "generic-im-conversation",
        prompt: "",
        scopeKey: "telegram:chat:tg-chat-1",
        truncated: false
      },
      conversationId: "generic-im-conversation",
      prompt: "#720 有结果了告诉我",
      title: "Telegram"
    });

    const watchAction = listPiActions(database).find((action) => action.action_type === "issue_completion_watch.create");
    expect(watchAction).toMatchObject({ status: "completed" });
    expect(firstActionEventPayload(database, "generic-im-conversation", "supervisor_context_resolved")).toMatchObject({
      provenance: { context_inheritance_allowed: false, source: "telegram_runner_chat" }
    });
    const watchID = (JSON.parse(watchAction?.result_json || "{}") as { watch_id?: string }).watch_id ?? "";
    expect(getPiIssueCompletionWatch(database, watchID)).toMatchObject({ target_channel: "telegram", target_chat_id: "tg-chat-1" });
  });

  test("reads persisted PI conversation transcript for history switching", async () => {
    const { database, router } = await piFixture();
    const sessionDir = join(database.path, "..", "pi-runtime", "sessions");
    const sessionFile = join(sessionDir, "fixture_conv-history.jsonl");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(sessionFile, [["user-1", "user", "hello runner"], ["assistant-1", "assistant", "history reply"]]
      .map(([id, role, text]) => JSON.stringify({
        type: "message", id, timestamp: FIXTURE_TIME, message: { role, content: [{ type: "text", text }] }
      }))
      .join("\n"));
    insertRow(database, "pi_conversations", {
      id: "conv-history", project_id: "demo", pi_agent_id: "runner-default", title: "History", status: "active",
      session_file: sessionFile, pi_session_id: "conv-history", created_at: FIXTURE_TIME, updated_at: FIXTURE_TIME
    });

    const body = await getJson(router, "/api/pi/conversations/conv-history");
    const meta = { conversation_id: "conv-history", pi_session_id: "conv-history" };
    expect(body.message_count).toBe(2);
    expect(body.transcript).toEqual([
      { id: "user-1", role: "user", text: "hello runner", created_at: FIXTURE_TIME, meta },
      { id: "assistant-1", role: "assistant", text: "history reply", created_at: FIXTURE_TIME, meta }
    ]);
  });

  test("returns provider errors as visible Runner text", async () => {
    const { faux, open, send } = await piFixture();
    faux.setResponses([fauxAssistantMessage([], {
      stopReason: "error",
      errorMessage: "fatal provider failure CODEX_API_KEY=fixture-secret"
    })]);
    await open("conv-provider-error", { project_id: "demo" });

    const message = await send("conv-provider-error", "hello");
    const failed = (await readPiConversationSse(message)).at(-1);

    expect(message.status).toBe(201);
    expect(failed?.event).toBe("failed");
    expect(failed?.data.status).toBe("failed");
    expect(failed?.data.text).toContain("Runner 执行失败：fatal provider failure");
    expect(failed?.data.text).toContain("CODEX_API_KEY=[redacted]");
    expect(JSON.stringify(failed?.data)).not.toContain("fixture-secret");
  });

  test("interrupts a running PI conversation", async () => {
    const { faux, router, open, send, sendWhenIdle } = await piFixture({
      faux: { tokenSize: { min: 1, max: 1 }, tokensPerSecond: 1 }
    });
    faux.setResponses([fauxAssistantMessage("slow response"), fauxAssistantMessage("ok")]);
    await open("conv-interrupt", { project_id: "demo" });

    const running = send("conv-interrupt", "please stream slowly");
    await waitFor(() => faux.state.callCount > 0);
    const interrupt = await post(router, "/api/pi/conversations/conv-interrupt/interrupt");
    const result = await running;

    expect(interrupt.status).toBe(200);
    expect(await interrupt.json()).toMatchObject({ interrupted: true, conversation_id: "conv-interrupt" });
    expect(result.status).toBe(201);
    expect((await readPiConversationSse(result)).at(-1)).toMatchObject({
      event: "failed",
      data: { conversation_id: "conv-interrupt", error: { code: "interrupted" }, status: "failed", text: "" }
    });
    expect(await finalPiConversationSseData(await sendWhenIdle("conv-interrupt", "start a fresh turn")))
      .toMatchObject({ conversation_id: "conv-interrupt", status: "completed", text: "ok" });
    expect(faux.state.callCount).toBe(2);
  });

  test("client cancellation detaches the SSE response without aborting or duplicating the turn", async () => {
    const { faux, open, send, sendWhenIdle, transcriptWith } = await piFixture();
    const providerGate = Promise.withResolvers<void>();
    faux.setResponses([
      async () => {
        await providerGate.promise;
        return fauxAssistantMessage("persist after disconnect");
      },
      fauxAssistantMessage("next turn")
    ]);
    await open("conv-cancel", { project_id: "demo" });

    const disconnected = await send("conv-cancel", "keep running");
    await waitFor(() => faux.state.callCount > 0);
    await disconnected.body?.cancel();
    expect((await send("conv-cancel", "must not duplicate")).status).toBe(409);

    providerGate.resolve();
    expect((await transcriptWith("conv-cancel", "persist after disconnect")).transcript).toEqual([
      expect.objectContaining({ role: "user", text: "keep running" }),
      expect.objectContaining({ role: "assistant", text: "persist after disconnect" })
    ]);
    expect(faux.state.callCount).toBe(1);
    expect(await finalPiConversationSseData(await sendWhenIdle("conv-cancel", "next"))).toMatchObject({
      conversation_id: "conv-cancel",
      message_count: 4,
      status: "completed",
      text: "next turn"
    });
  });
});

const PNG_FIXTURE = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAEElEQVR4AQEFAPr/AP////8J+wP9o9FJCgAAAABJRU5ErkJggg==",
  "base64"
);

type Router = ReturnType<typeof createDefaultRouter>;

/** A database whose PI agent runs on a fresh faux model, seeded projects, and conversation helpers over a router. */
async function piFixture(options: { bus?: EventBus; executor?: ExecutorProvider; faux?: FauxPiOptions; projects?: string[] } = {}) {
  const database = await openFixtureDatabase();
  const faux = fauxPi(database, options.faux);
  for (const id of options.projects ?? ["demo"]) {
    insertProject(database, id, { provider_config_json: '{"capabilities":["issue_execution"]}' });
  }
  const router = createDefaultRouter({
    database,
    ...(options.bus ? { bus: options.bus } : {}),
    ...(options.executor ? { providers: { codex: options.executor } } : {})
  });
  const send = (id: string, prompt: string) => post(router, `/api/pi/conversations/${id}/messages`, { prompt });
  return {
    database,
    faux,
    router,
    send,
    open: (id: string, body: Record<string, unknown> = {}) => post(router, "/api/pi/conversations", { id, ...body }),
    /** Sends one prompt and returns the final SSE frame of the turn. */
    ask: async (id: string, prompt: string) => {
      const response = await send(id, prompt);
      expect(response.status).toBe(201);
      return finalPiConversationSseData(response);
    },
    /** Retries while the previous turn of the conversation is still releasing its slot (409). */
    sendWhenIdle: (id: string, prompt: string) => waitFor(async () => {
      const response = await send(id, prompt);
      return response.status === 409 ? undefined : response;
    }, "active PI turn did not clean up"),
    transcriptWith: (id: string, text: string) => waitFor(async () => {
      const body = await getJson(router, `/api/pi/conversations/${encodeURIComponent(id)}`);
      return (body.transcript ?? []).some((item: { text?: string }) => item?.text === text) ? body : undefined;
    }, `persisted PI transcript did not include: ${text}`)
  };
}

function post(router: Router, path: string, body?: Record<string, unknown>) {
  return router.handle(new Request(`${BASE_URL}${path}`, body === undefined ? { method: "POST" } : {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" }
  }));
}

async function getJson(router: Router, path: string): Promise<any> {
  const response = await router.handle(new Request(`${BASE_URL}${path}`));
  expect(response.status).toBe(200);
  return response.json();
}

/** One assistant turn that calls a single tool. */
function toolUse(name: string, args: Parameters<typeof fauxToolCall>[1]) {
  return fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
}

/** One assistant turn that invokes a builtin tool through `capability_invoke` with its current schema hash. */
function capabilityInvoke(name: string, args: Parameters<typeof fauxToolCall>[1]) {
  const tool = listBuiltinAssistantTools().find((candidate) => candidate.name === name)!;
  return toolUse("capability_invoke", {
    tool_id: `${tool.provider_id}:${name}`,
    schema_hash: createHash("sha256").update(JSON.stringify(tool.input_schema)).digest("hex"),
    arguments: args
  });
}

function actionEvents(db: RunnerDatabase, conversationId: string, eventType: string) {
  return listPiActionEvents(db, { conversationId, eventType });
}

function firstActionEventPayload(db: RunnerDatabase, conversationId: string, eventType: string): unknown {
  return JSON.parse(actionEvents(db, conversationId, eventType)[0]?.payload_json || "{}");
}

/** The cwd recorded in the PI session file header of a conversation. */
function sessionCwd(db: RunnerDatabase, conversationId: string): unknown {
  const file = getPiConversation(db, conversationId)?.session_file;
  return file ? JSON.parse(readFileSync(file, "utf8").split("\n")[0] || "{}").cwd : undefined;
}

function insertUpload(db: RunnerDatabase, id: string): void {
  const uploadDir = join(db.path, "..", "uploads", "fixtures");
  const storagePath = join(uploadDir, `${id}.png`);
  mkdirSync(uploadDir, { recursive: true });
  writeFileSync(storagePath, PNG_FIXTURE);
  insertRow(db, "uploads", {
    id, original_name: "one.png", mime_type: "image/png", size_bytes: PNG_FIXTURE.byteLength,
    sha256: "fixture-sha", storage_path: storagePath, created_at: FIXTURE_TIME
  });
}

function seedManualContextEvents(db: RunnerDatabase): void {
  const messages: Array<[string, string, string, Record<string, unknown>?]> = [
    ["m1", "2026-07-06T01:01:00Z", "登录页 500，是个 bug"],
    ["m2", "2026-07-06T01:02:00Z", "截图如下", { attachments: [{ kind: "image", mime: "image/png", name: "login.png" }] }],
    ["m3", "2026-07-06T01:03:00Z", "请帮忙创建 issue"]
  ];
  for (const [external_id, occurred_at, content, overrides] of messages) {
    createExternalEvent(db, {
      content,
      external_id,
      normalized_message: { chat_id: "group-1", chat_type: "group", message_id: external_id, thread_id: "thread-a" },
      occurred_at,
      provider: "fixture-provider",
      raw_json: { text: content },
      received_at: occurred_at,
      source: "fixture-im",
      ...overrides
    });
  }
}

function imageSummary(context: unknown): string {
  const value = context && typeof context === "object"
    ? context as { messages?: Array<{ content?: string | unknown[]; role?: string }> }
    : {};
  const user = (value.messages ?? []).slice().reverse().find((message) => message.role === "user");
  const images = (Array.isArray(user?.content) ? user.content : []).filter(isImageContent);
  const image = images[0];
  return `images=${images.length}; mime=${image?.mimeType ?? ""}; bytes=${image ? Buffer.from(image.data, "base64").byteLength : 0}`;
}

function isImageContent(value: unknown): value is { data: string; mimeType: string; type: string } {
  return typeof value === "object" && value !== null && (value as { type?: unknown }).type === "image";
}

class FakeExecutorProvider implements ExecutorProvider {
  readonly id = "codex" as const;
  readonly capabilities = ["issue_execution"] as const;
  readonly calls: ProviderRunInput[] = [];

  async run(input: ProviderRunInput) {
    this.calls.push(input);
    return {
      runId: `fake-run-${input.issueId}`,
      session: { provider: this.id, sessionId: `thread-${input.issueId}`, turnId: `turn-${input.issueId}` }
    };
  }
}
