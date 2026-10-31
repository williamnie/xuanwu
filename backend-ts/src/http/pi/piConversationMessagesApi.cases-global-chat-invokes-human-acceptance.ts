import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { listIssues } from "../../db/repositories/issues.ts";
import { getPiConversation, listPiActions } from "../../db/repositories/pi.ts";
import { EventBus } from "../../events/bus.ts";
import { parsePiConversationSse } from "./piConversationSse.testSupport.ts";
import { upsertAgentSession } from "../../db/repositories/agentSessions.ts";
import { createIssueRun } from "../../db/repositories/issueRuns.ts";
import { readIssueDecisionProjection } from "../../domain/review/humanReview.ts";
import { insertIssue } from "../../testing/harness.ts";
import type { TestFixture } from "./piConversationMessagesApi.testFixture.ts";

export function registerGlobalChatInvokesHumanAcceptanceCases(testScope: TestFixture) {
  const { PNG_FIXTURE, piFixture, getJson, toolUse, capabilityInvoke, actionEvents, insertUpload, imageSummary } = testScope;
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
}
