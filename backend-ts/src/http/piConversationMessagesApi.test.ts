import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { listContextBundles } from "../db/repositories/contextBundles.ts";
import { createExternalEvent } from "../db/repositories/externalEvents.ts";
import { listIssues } from "../db/repositories/issues.ts";
import { getPiConversation, getPiIssueCompletionWatch, listPiActionEvents, listPiActions } from "../db/repositories/pi.ts";
import type { ExecutorProvider, ProviderRunInput } from "../providers/types.ts";
import { EventBus } from "../events/bus.ts";
import { runPiConversationPrompt } from "./piConversationApi.ts";
import {
  finalPiConversationSseData,
  parsePiConversationSse,
  readPiConversationSse
} from "./piConversationSse.testSupport.ts";
import { createDefaultRouter } from "./server.ts";
import { getAgentSession } from "../db/repositories/agentSessions.ts";

const BASE_URL = "http://127.0.0.1:3008";
const tempRoots: string[] = [];

async function openFixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "xuanwu-bun-pi-message-api-"));
  tempRoots.push(root);
  return openDatabase({ stateDir: join(root, "state") });
}

afterEach(async () => {
  while (tempRoots.length > 0) {
    const path = tempRoots.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

describe("Bun PI conversation message API", () => {
  test("streams accepted and ordered assistant deltas before PI completion", async () => {
    const database = await openFixtureDatabase();
    const faux = registerFauxProvider({
      api: "pi-test-faux-api",
      provider: "pi-test-faux",
      tokenSize: { min: 1, max: 1 }
    });
    let releaseProvider = () => {};
    const providerGate = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    let providerCompleted = false;
    try {
      faux.setResponses([async () => {
        await providerGate;
        providerCompleted = true;
        return fauxAssistantMessage("pi reply");
      }]);
      insertProject(database, "demo");
      insertFauxAgent(database);
      writeFauxModelsConfig(database);
      const bus = new EventBus();
      const events = bus.subscribe();
      const router = createDefaultRouter({ bus, database });
      let partialDetailPromise: Promise<any> | undefined;
      const stopObserving = bus.observe((event) => {
        if (event.type === "pi.conversation.event" && event.agent_event_type === "message_update" && event.text) {
          partialDetailPromise ??= getJson(router, "/api/pi/conversations/conv-msg");
        }
      });

      const created = await request(router, "/api/pi/conversations", {
        id: "conv-msg",
        project_id: "demo"
      });
      await request(router, "/api/pi/conversations", {
        id: "conv-idle",
        project_id: "demo"
      });
      const message = await request(router, "/api/pi/conversations/conv-msg/messages", {
        prompt: "hello"
      });
      const reader = message.body?.getReader();
      const first = await reader?.read();
      const firstText = new TextDecoder().decode(first?.value);

      expect(created.status).toBe(201);
      expect(message.status).toBe(201);
      expect(message.headers.get("content-type")).toContain("text/event-stream");
      expect(firstText).toContain("event: accepted");
      expect(firstText).not.toContain("event: completed");
      expect(providerCompleted).toBe(false);
      const activeList = await getJson(router, "/api/pi/conversations");
      expect(activeList[0]).toMatchObject({
        id: "conv-msg",
        runtime_status: "running"
      });
      expect(activeList[0]?.active_turn_id).toBeTruthy();
      const activeDetail = await getJson(router, "/api/pi/conversations/conv-msg");
      expect(activeDetail).toMatchObject({
        active_text: "",
        active_turn_id: activeList[0]?.active_turn_id,
        runtime_status: "running"
      });

      releaseProvider();
      let remainingText = "";
      while (reader) {
        const chunk = await reader.read();
        if (chunk.done) break;
        remainingText += new TextDecoder().decode(chunk.value);
      }
      const turnEvents = parsePiConversationSse(`${firstText}${remainingText}`);
      const accepted = turnEvents.find((event) => event.event === "accepted");
      const deltas = turnEvents.filter((event) => event.event === "assistant_text_delta");
      const completed = turnEvents.find((event) => event.event === "completed");
      const partialDetail = await partialDetailPromise as any;
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
      const persisted = await waitForConversationTranscript(router, "conv-msg", "pi reply");
      expect(persisted).toMatchObject({ active_text: "", active_turn_id: "", runtime_status: "idle" });
      expect(persisted.transcript).toEqual([
        expect.objectContaining({ role: "user", text: "hello" }),
        expect.objectContaining({ role: "assistant", text: "pi reply" })
      ]);
    } finally {
      faux.unregister();
      database.close();
    }
  });

  test("derives stable conversation title from markdown prompt", async () => {
    const database = await openFixtureDatabase();
    const faux = registerFauxProvider({ api: "pi-title-faux-api", provider: "pi-title-faux" });
    try {
      faux.setResponses([fauxAssistantMessage("ok")]);
      insertProject(database, "demo");
      insertFauxAgent(database, "pi-title-faux");
      writeFauxModelsConfig(database, "pi-title-faux");
      const router = createDefaultRouter({ database });
      await request(router, "/api/pi/conversations", {
        id: "conv-title", project_id: "demo", title: "New conversation"
      });
      const message = await request(router, "/api/pi/conversations/conv-title/messages", {
        prompt: "帮我看下 **Runner Markdown** 渲染"
      });
      expect(message.status).toBe(201);
      expect(await finalPiConversationSseData(message))
        .toMatchObject({ conversation_id: "conv-title", title: "帮我看下 Runner Markdown 渲染" });
    } finally {
      faux.unregister();
      database.close();
    }
  });

  test("lets PI choose a concrete tool without a pre-LLM intent route", async () => {
    const database = await openFixtureDatabase();
    const faux = registerFauxProvider({ api: "pi-intent-route-api", provider: "pi-intent-route" });
    try {
      faux.setResponses([
        fauxAssistantMessage([
          fauxToolCall("issue_create_proposal", {
            description: "PI chose a concrete issue after reading the conversation",
            title: "PI-created issue"
          }, { id: "ambiguous-create" })
        ], { stopReason: "toolUse" }),
        fauxAssistantMessage("已创建 issue。")
      ]);
      insertProject(database, "demo");
      insertFauxAgent(database, "pi-intent-route");
      writeFauxModelsConfig(database, "pi-intent-route");
      const router = createDefaultRouter({ database });
      await request(router, "/api/pi/conversations", {
        id: "conv-intent-route", project_id: "demo"
      });

      const message = await request(router, "/api/pi/conversations/conv-intent-route/messages", {
        prompt: "处理一下"
      });
      const result = await finalPiConversationSseData(message);
      const routeEvents = listPiActionEvents(database, {
        conversationId: "conv-intent-route",
        eventType: "supervisor_intent_routed"
      });
      const contextEvents = listPiActionEvents(database, {
        conversationId: "conv-intent-route",
        eventType: "supervisor_context_resolved"
      });
      const contextResolution = JSON.parse(contextEvents[0]?.payload_json || "{}") as Record<string, unknown>;
      const createAction = listPiActions(database).find((action) => action.action_type === "issue.create");

      expect(message.status).toBe(201);
      expect(result).toMatchObject({
        text: "已创建 issue。"
      });
      expect(listIssues(database, { projectId: "demo" })).toContainEqual(expect.objectContaining({
        title: "PI-created issue"
      }));
      expect(createAction).toMatchObject({ gate_decision: "execute", status: "completed" });
      expect(routeEvents).toEqual([]);
      expect(contextEvents).toHaveLength(1);
      expect(contextResolution).toMatchObject({
        status: "resolved",
        target: { project_id: "demo", work_ids: [] },
        candidates: [expect.objectContaining({
          project_id: "demo",
          sources: [expect.objectContaining({ kind: "current_page" })]
        })]
      });
      expect(contextEvents[0]?.payload_json).not.toContain("处理一下");
    } finally {
      faux.unregister();
      database.close();
    }
  });

  test("lets PI create a local project and write its PRD without starting coding Work", async () => {
    const database = await openFixtureDatabase();
    const faux = registerFauxProvider({ api: "pi-local-project-api", provider: "pi-local-project" });
    const projectRoot = join(database.path, "..", "fashion-studio");
    try {
      faux.setResponses([
        fauxAssistantMessage([
          fauxToolCall("project_create", {
            cwd: projectRoot,
            id: "fashion-studio",
            name: "Fashion Studio"
          }, { id: "create-local-project" })
        ], { stopReason: "toolUse" }),
        fauxAssistantMessage([
          fauxToolCall("workspace_write_file", {
            content: "# Fashion Studio PRD\n\n## MVP\n服装模特图与首屏图。\n",
            path: "PRD.md",
            project_id: "fashion-studio"
          }, { id: "write-local-prd" })
        ], { stopReason: "toolUse" }),
        fauxAssistantMessage(`项目已创建，PRD 已写入 ${join(projectRoot, "PRD.md")}。`)
      ]);
      insertFauxAgent(database, "pi-local-project");
      writeFauxModelsConfig(database, "pi-local-project");
      const router = createDefaultRouter({ database });
      await request(router, "/api/pi/conversations", { id: "conv-local-project" });

      const message = await request(router, "/api/pi/conversations/conv-local-project/messages", {
        prompt: `请在 ${projectRoot} 新建项目，并根据当前对话把 PRD 写入 PRD.md`
      });
      const result = await finalPiConversationSseData(message);

      expect(message.status).toBe(201);
      expect(result.text).toContain("PRD 已写入");
      expect(readFileSync(join(projectRoot, "PRD.md"), "utf8")).toContain("服装模特图与首屏图");
      expect(getPiConversation(database, "conv-local-project")).toMatchObject({ project_id: "fashion-studio" });
      expect(listIssues(database, { projectId: "fashion-studio" })).toEqual([]);
      expect(listPiActions(database)).toEqual(expect.arrayContaining([
        expect.objectContaining({ action_type: "project.create", gate_decision: "execute", status: "completed" }),
        expect.objectContaining({ action_type: "workspace.write_file", gate_decision: "execute", status: "completed" })
      ]));
    } finally {
      faux.unregister();
      database.close();
    }
  });

  test("passes uploaded attachment images to PI SDK prompt", async () => {
    const database = await openFixtureDatabase();
    const faux = registerFauxProvider({ api: "pi-image-faux-api", provider: "pi-image-faux" });
    try {
      faux.setResponses([(context) => fauxAssistantMessage(imageSummary(context))]);
      insertProject(database, "demo");
      insertFauxAgent(database, "pi-image-faux");
      insertUpload(database, "upload_pi_image");
      writeFauxModelsConfig(database, "pi-image-faux");
      const router = createDefaultRouter({ database });
      await request(router, "/api/pi/conversations", {
        id: "conv-image", project_id: "demo"
      });

      const message = await request(router, "/api/pi/conversations/conv-image/messages", {
        prompt: "这张图有什么？\n\n![uploaded image](attachment://upload_pi_image)"
      });
      const body = await finalPiConversationSseData(message);

      expect(message.status).toBe(201);
      expect(body.text).toBe(`images=1; mime=image/png; bytes=${PNG_FIXTURE.byteLength}`);
    } finally {
      faux.unregister();
      database.close();
    }
  });

  test("manual context tool returns a bundle for PI to interpret without hardcoded proposals", async () => {
    const database = await openFixtureDatabase();
    const faux = registerFauxProvider({ api: "pi-manual-trigger-api", provider: "pi-manual-trigger" });
    try {
      const prompt = "看看刚刚群里的截图和消息，是个 bug，创建 issue";
      faux.setResponses([
        fauxAssistantMessage([
          fauxToolCall("manual_context_intake", {
            now: "2026-07-06T01:10:00Z",
            require_attachments: true,
            source: "fixture-im"
          }, { id: "manual-context" })
        ], { stopReason: "toolUse" }),
        fauxAssistantMessage("我已读取上下文；下一步由我根据 bundle 决定。")
      ]);
      insertProject(database, "demo");
      insertFauxAgent(database, "pi-manual-trigger");
      writeFauxModelsConfig(database, "pi-manual-trigger");
      seedManualContextEvents(database);
      const router = createDefaultRouter({ database });
      await request(router, "/api/pi/conversations", {
        id: "conv-manual-trigger", project_id: "demo"
      });

      const message = await request(router, "/api/pi/conversations/conv-manual-trigger/messages", { prompt });
      const result = await finalPiConversationSseData(message);
      const bundle = listContextBundles(database, "fixture-im", 1)[0];
      const proposal = listPiActions(database).find((action) => action.action_type === "attention_inbox.domain_skill");

      expect(message.status).toBe(201);
      expect(result).toMatchObject({ text: "我已读取上下文；下一步由我根据 bundle 决定。" });
      expect(bundle).toMatchObject({ created_by: "user", source: "fixture-im", trigger: "manual" });
      expect(bundle.source_query).toMatchObject({
        attachment_kinds: ["image"],
        manual_trigger: {
          conversation_id: "conv-manual-trigger",
          source: "runner_chat",
          user_prompt: prompt
        }
      });
      expect(proposal).toBeUndefined();
      expect(listIssues(database, { projectId: "demo" })).toEqual([]);
    } finally {
      faux.unregister();
      database.close();
    }
  });

  test("Feishu PI conversation creates an issue, enqueues it, and starts executor session", async () => {
    const database = await openFixtureDatabase();
    const faux = registerFauxProvider({ api: "pi-feishu-run-faux-api", provider: "pi-feishu-run-faux" });
    const provider = new FakeExecutorProvider();
    try {
      faux.setResponses([
        fauxAssistantMessage([
          fauxToolCall("issue_create_proposal", {
            description: "修复登录 bug",
            title: "Feishu task"
          }, { id: "issue-create" }),
          fauxToolCall("issue_enqueue_proposal", {
            issue_id: 1,
            rationale: "Feishu task should start immediately"
          }, { id: "issue-enqueue" })
        ], { stopReason: "toolUse" }),
        fauxAssistantMessage("已创建 issue #1 并开始执行。")
      ]);
      insertProject(database, "demo");
      insertFauxAgent(database, "pi-feishu-run-faux");
      writeFauxModelsConfig(database, "pi-feishu-run-faux");
      const router = createDefaultRouter({ database, providers: { codex: provider } });
      await request(router, "/api/pi/conversations", {
        id: "feishu-om-run", project_id: "demo"
      });

      const message = await request(router, "/api/pi/conversations/feishu-om-run/messages", {
        prompt: "@PI 帮我在 demo 修复登录 bug"
      });
      const result = await finalPiConversationSseData(message);

      const issues = listIssues(database, { projectId: "demo" });
      expect(message.status).toBe(201);
      expect(result).toMatchObject({
        conversation_id: "feishu-om-run",
        status: "completed",
        text: "已创建 issue #1 并开始执行。"
      });
      expect(issues).toMatchObject([
        { project_id: "demo", status: "in_progress", title: "Feishu task" }
      ]);
      await until(() => provider.calls.length > 0);
      expect(provider.calls).toMatchObject([{ issueId: issues[0]?.id, projectId: "demo" }]);
    } finally {
      faux.unregister();
      database.close();
    }
  });

  test("Feishu runner chat can manage issues from another issue project without switching context", async () => {
    const database = await openFixtureDatabase();
    const faux = registerFauxProvider({ api: "pi-feishu-cross-issue-api", provider: "pi-feishu-cross-issue" });
    const provider = new FakeExecutorProvider();
    try {
      faux.setResponses([
        fauxAssistantMessage([
          fauxToolCall("issue_enqueue_proposal", {
            issue_id: 501,
            rationale: "start named issue project task"
          }, { id: "issue-enqueue-501" })
        ], { stopReason: "toolUse" }),
        fauxAssistantMessage("已开始 movo-mobile 的 #501。")
      ]);
      insertProject(database, "xuanwu");
      insertProject(database, "movo-mobile");
      insertIssue(database, { id: 501, projectID: "movo-mobile", title: "Mobile issue" });
      insertFauxAgent(database, "pi-feishu-cross-issue");
      writeFauxModelsConfig(database, "pi-feishu-cross-issue");
      const router = createDefaultRouter({ database, providers: { codex: provider } });
      await request(router, "/api/pi/conversations", {
        id: "feishu-cross-issue", project_id: "xuanwu"
      });

      const message = await request(router, "/api/pi/conversations/feishu-cross-issue/messages", {
        prompt: "开始 movo-mobile 的 #501"
      });
      const result = await finalPiConversationSseData(message);

      const actions = listPiActions(database);
      expect(message.status).toBe(201);
      expect(result).toMatchObject({
        conversation_id: "feishu-cross-issue",
        status: "completed",
        text: "已开始 movo-mobile 的 #501。"
      });
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
      await until(() => provider.calls.length > 0);
      expect(provider.calls).toMatchObject([{ issueId: 501, projectId: "movo-mobile" }]);
    } finally {
      faux.unregister();
      database.close();
    }
  });

  test("Feishu issue-id prompt targets a project without rebinding the IM conversation", async () => {
    const database = await openFixtureDatabase();
    const faux = registerFauxProvider({ api: "pi-feishu-issue-run-api", provider: "pi-feishu-issue-run" });
    const provider = new FakeExecutorProvider();
    try {
      faux.setResponses([
        fauxAssistantMessage([
          fauxToolCall("issue_enqueue_proposal", {
            issue_id: 386,
            rationale: "Feishu asked to start this explicit issue"
          }, { id: "issue-enqueue-386" })
        ], { stopReason: "toolUse" }),
        fauxAssistantMessage("已开始 #386。")
      ]);
      insertProject(database, "demo");
      insertIssue(database, { id: 386, projectID: "demo", title: "Explicit Feishu issue" });
      insertFauxAgent(database, "pi-feishu-issue-run");
      writeFauxModelsConfig(database, "pi-feishu-issue-run");
      await request(createDefaultRouter({ database }), "/api/pi/conversations", {
        id: "feishu-global-before-issue", title: "Feishu"
      });

      const result = await runPiConversationPrompt({ database, providers: { codex: provider } }, {
        conversationId: "feishu-global-before-issue",
        prompt: "开始 #386",
        targetProjectId: "demo",
        title: "Feishu"
      });
      await until(() => provider.calls.length > 0);

      const actions = listPiActions(database);
      const conversation = getPiConversation(database, "feishu-global-before-issue");
      const sessionHeader = conversation ? readSessionHeader(conversation.session_file) : {};
      expect(result).toMatchObject({ conversation_id: "feishu-global-before-issue", text: "已开始 #386。" });
      expect(conversation).toMatchObject({ project_id: "" });
      expect(sessionHeader.cwd).not.toBe("/tmp/demo");
      expect(actions.filter((action) => action.status === "pending")).toEqual([]);
      expect(actions).toMatchObject([{
        action_type: "issue.enqueue",
        gate_decision: "execute",
        issue_id: 386,
        project_id: "demo",
        status: "completed"
      }]);
      expect(listIssues(database, { projectId: "demo" })).toMatchObject([
        { id: 386, project_id: "demo", status: "in_progress" }
      ]);
      expect(provider.calls).toMatchObject([{ issueId: 386, projectId: "demo" }]);
    } finally {
      faux.unregister();
      database.close();
    }
  });

  test("Feishu unbound follow-up asks for approval when PI resolves a mutation target from conversation semantics", async () => {
    const database = await openFixtureDatabase();
    const faux = registerFauxProvider({ api: "pi-feishu-semantic-target-api", provider: "pi-feishu-semantic-target" });
    const provider = new FakeExecutorProvider();
    try {
      faux.setResponses([
        fauxAssistantMessage([
          fauxToolCall("issue_enqueue_proposal", {
            issue_id: 387,
            rationale: "resolved from the conversation history"
          }, { id: "issue-enqueue-387" })
        ], { stopReason: "toolUse" }),
        fauxAssistantMessage("已向你发起 #387 的执行确认，批准后才会开始。")
      ]);
      insertProject(database, "demo");
      insertIssue(database, { id: 387, projectID: "demo", title: "Semantic target" });
      insertFauxAgent(database, "pi-feishu-semantic-target");
      writeFauxModelsConfig(database, "pi-feishu-semantic-target");
      await request(createDefaultRouter({ database }), "/api/pi/conversations", {
        id: "feishu-semantic-target",
        title: "Feishu"
      });

      const message = await request(createDefaultRouter({ database, providers: { codex: provider } }),
        "/api/pi/conversations/feishu-semantic-target/messages", { prompt: "我已经改好了，开始吧" });
      const result = await finalPiConversationSseData(message);
      const action = listPiActions(database).find((item) => item.action_type === "issue.enqueue");

      expect(result).toMatchObject({
        conversation_id: "feishu-semantic-target",
        text: "已向你发起 #387 的执行确认，批准后才会开始。"
      });
      expect(action).toMatchObject({
        gate_decision: "ask",
        gate_reason: "action is allowed by policy but requires explicit user approval for this target",
        issue_id: 387,
        project_id: "demo",
        status: "pending"
      });
      expect(listIssues(database, { projectId: "demo" }).find((issue) => issue.id === 387)?.status).toBe("triage");
      expect(provider.calls).toEqual([]);
    } finally {
      faux.unregister();
      database.close();
    }
  });

  test("Feishu short retry reaches PI with its trusted Issue context and no intent router", async () => {
    const database = await openFixtureDatabase();
    const faux = registerFauxProvider({ api: "pi-feishu-retry-context-api", provider: "pi-feishu-retry-context" });
    try {
      faux.setResponses([
        fauxAssistantMessage("我会先核对该 Work 的完成态，再决定是否需要重试。")
      ]);
      insertProject(database, "demo");
      insertIssue(database, { id: 774, projectID: "demo", title: "Retry context issue" });
      insertFauxAgent(database, "pi-feishu-retry-context");
      writeFauxModelsConfig(database, "pi-feishu-retry-context");

      const result = await runPiConversationPrompt({ database }, {
        conversationId: "feishu-retry-context",
        prompt: "重试吧",
        targetIssueId: 774,
        targetProjectId: "demo",
        title: "Feishu"
      });
      const routeEvents = listPiActionEvents(database, {
        conversationId: "feishu-retry-context",
        eventType: "supervisor_intent_routed"
      });
      const contextEvents = listPiActionEvents(database, {
        conversationId: "feishu-retry-context",
        eventType: "supervisor_context_resolved"
      });
      const context = JSON.parse(contextEvents[0]?.payload_json || "{}") as Record<string, unknown>;

      expect(result).toMatchObject({
        conversation_id: "feishu-retry-context",
        text: "我会先核对该 Work 的完成态，再决定是否需要重试。"
      });
      expect(routeEvents).toEqual([]);
      expect(context).toMatchObject({
        status: "resolved",
        target: { project_id: "demo", work_ids: ["xw:work:issues:774"] }
      });
      expect(listIssues(database, { projectId: "demo" })).toMatchObject([
        { id: 774, status: "triage" }
      ]);
    } finally {
      faux.unregister();
      database.close();
    }
  });

  test("Feishu IM one-shot project target scopes issue tools without switching runtime cwd", async () => {
    const database = await openFixtureDatabase();
    const faux = registerFauxProvider({ api: "pi-feishu-target-api", provider: "pi-feishu-target" });
    try {
      faux.setResponses([
        fauxAssistantMessage([
          fauxToolCall("issue_status_summary", {}, { id: "issue-status-demo" })
        ], { stopReason: "toolUse" }),
        fauxAssistantMessage("demo 当前有 1 个 triage issue。")
      ]);
      insertProject(database, "xuanwu");
      insertProject(database, "demo");
      insertProject(database, "other");
      insertIssue(database, { id: 700, projectID: "demo", title: "Demo issue" });
      insertIssue(database, { id: 701, projectID: "other", title: "Other issue" });
      insertFauxAgent(database, "pi-feishu-target");
      writeFauxModelsConfig(database, "pi-feishu-target");
      await request(createDefaultRouter({ database }), "/api/pi/conversations", {
        id: "feishu-im-target-project",
        project_id: "xuanwu",
        title: "Feishu"
      });

      const result = await runPiConversationPrompt({ database }, {
        clearProjectId: true,
        conversationId: "feishu-im-target-project",
        prompt: "demo 当前还有多少 issue",
        targetProjectId: "demo",
        title: "Feishu"
      });

      const action = listPiActions(database).find((item) => item.action_type === "issue.status_summary");
      const conversation = getPiConversation(database, "feishu-im-target-project");
      const agentSession = getAgentSession(database, "pi-sdk:feishu-im-target-project");
      const sessionHeader = conversation ? readSessionHeader(conversation.session_file) : {};
      expect(result).toMatchObject({
        conversation_id: "feishu-im-target-project",
        text: "demo 当前有 1 个 triage issue。"
      });
      expect(conversation).toMatchObject({ project_id: "" });
      expect(agentSession).toMatchObject({ project_id: "" });
      expect(sessionHeader.cwd).not.toBe("/tmp/demo");
      expect(sessionHeader.cwd).not.toBe("/tmp/xuanwu");
      expect(action).toMatchObject({
        action_type: "issue.status_summary",
        project_id: "demo",
        status: "completed"
      });
    } finally {
      faux.unregister();
      database.close();
    }
  });

  test("Feishu generic counts do not inherit the Project from the previous turn", async () => {
    const database = await openFixtureDatabase();
    const faux = registerFauxProvider({ api: "pi-feishu-scope-api", provider: "pi-feishu-scope" });
    try {
      faux.setResponses([
        fauxAssistantMessage([fauxToolCall("issue_status_summary", {}, { id: "project-count" })], { stopReason: "toolUse" }),
        fauxAssistantMessage("demo 有 1 个未完成 issue。"),
        fauxAssistantMessage([fauxToolCall("issue_status_summary", {}, { id: "global-count" })], { stopReason: "toolUse" }),
        fauxAssistantMessage("全局有 2 个未完成 issue。")
      ]);
      insertProject(database, "demo");
      insertProject(database, "other");
      insertIssue(database, { id: 710, projectID: "demo", title: "Demo issue" });
      insertIssue(database, { id: 711, projectID: "other", title: "Other issue" });
      insertFauxAgent(database, "pi-feishu-scope");
      writeFauxModelsConfig(database, "pi-feishu-scope");

      await runPiConversationPrompt({ database }, {
        conversationId: "feishu-count-scope",
        prompt: "demo 还有多少 issue 没做",
        targetProjectId: "demo",
        title: "Feishu"
      });
      const second = await runPiConversationPrompt({ database }, {
        conversationId: "feishu-count-scope",
        prompt: "还有多少 issue 没做",
        title: "Feishu"
      });

      const actions = listPiActions(database).filter((action) => action.action_type === "issue.status_summary");
      const globalAction = actions.find((action) => JSON.parse(action.payload_json).scope === "global");
      const projectAction = actions.find((action) => JSON.parse(action.payload_json).scope === "project");
      expect(second.text).toBe("全局有 2 个未完成 issue。");
      expect(actions).toHaveLength(2);
      expect(globalAction).toMatchObject({ project_id: "", status: "completed" });
      expect(projectAction).toMatchObject({ project_id: "demo", status: "completed" });
    } finally {
      faux.unregister();
      database.close();
    }
  });

  test("derives Telegram runner-chat authority from connector projection instead of conversation id", async () => {
    const database = await openFixtureDatabase();
    const faux = registerFauxProvider({ api: "pi-telegram-source-api", provider: "pi-telegram-source" });
    try {
      faux.setResponses([
        fauxAssistantMessage([fauxToolCall("issue_execution_status", { id: 720 }, { id: "telegram-status" })], { stopReason: "toolUse" }),
        fauxAssistantMessage([fauxToolCall("issue_completion_watch_create", {
          issue_ids: [720],
          project_id: "demo",
          target_channel: "feishu_runner_chat",
          target_chat_id: "oc_untrusted"
        }, { id: "telegram-watch" })], { stopReason: "toolUse" }),
        fauxAssistantMessage("Telegram source confirmed.")
      ]);
      insertProject(database, "demo");
      insertIssue(database, { id: 720, projectID: "demo", title: "Telegram watch" });
      insertFauxAgent(database, "pi-telegram-source");
      writeFauxModelsConfig(database, "pi-telegram-source");

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

      const event = listPiActionEvents(database, {
        conversationId: "generic-im-conversation",
        eventType: "supervisor_context_resolved"
      })[0];
      const watchAction = listPiActions(database).find((action) => action.action_type === "issue_completion_watch.create");
      expect(watchAction).toMatchObject({ status: "completed" });
      const watchID = (JSON.parse(watchAction?.result_json || "{}") as { watch_id?: string }).watch_id ?? "";
      expect(JSON.parse(event?.payload_json || "{}")).toMatchObject({
        provenance: {
          context_inheritance_allowed: false,
          source: "telegram_runner_chat"
        }
      });
      expect(getPiIssueCompletionWatch(database, watchID)).toMatchObject({
        target_channel: "telegram",
        target_chat_id: "tg-chat-1"
      });
    } finally {
      faux.unregister();
      database.close();
    }
  });

  test("reads persisted PI conversation transcript for history switching", async () => {
    const database = await openFixtureDatabase();
    try {
      insertProject(database, "demo");
      insertFauxAgent(database);
      const sessionFile = writeConversationSession(database, "conv-history", [
        sessionMessage("user-1", "user", "hello runner"),
        sessionMessage("assistant-1", "assistant", "history reply")
      ]);
      insertConversation(database, {
        id: "conv-history",
        projectId: "demo",
        sessionFile
      });
      const response = await createDefaultRouter({ database })
        .handle(new Request(`${BASE_URL}/api/pi/conversations/conv-history`));
      const body = await response.json() as Record<string, unknown>;

      expect(response.status).toBe(200);
      expect(body.message_count).toBe(2);
      expect(body.transcript).toEqual([
        {
          id: "user-1",
          role: "user",
          text: "hello runner",
          created_at: "2026-01-01T00:00:00Z",
          meta: { conversation_id: "conv-history", pi_session_id: "conv-history" }
        },
        {
          id: "assistant-1",
          role: "assistant",
          text: "history reply",
          created_at: "2026-01-01T00:00:00Z",
          meta: { conversation_id: "conv-history", pi_session_id: "conv-history" }
        }
      ]);
    } finally {
      database.close();
    }
  });

  test("returns provider errors as visible Runner text", async () => {
    const database = await openFixtureDatabase();
    const faux = registerFauxProvider({ api: "pi-error-faux-api", provider: "pi-error-faux" });
    try {
      const errorReply = fauxAssistantMessage([], {
        stopReason: "error",
        errorMessage: "fatal provider failure CODEX_API_KEY=fixture-secret"
      });
      faux.setResponses([errorReply]);
      insertProject(database, "demo");
      insertFauxAgent(database, "pi-error-faux");
      writeFauxModelsConfig(database, "pi-error-faux");
      const router = createDefaultRouter({ database });
      await request(router, "/api/pi/conversations", {
        id: "conv-provider-error",
        project_id: "demo",
      });

      const message = await request(router, "/api/pi/conversations/conv-provider-error/messages", {
        prompt: "hello"
      });
      const events = await readPiConversationSse(message);
      const failed = events.at(-1);
      const body = failed?.data ?? {};

      expect(message.status).toBe(201);
      expect(failed?.event).toBe("failed");
      expect(body.status).toBe("failed");
      expect(body.text).toContain("Runner 执行失败：fatal provider failure");
      expect(body.text).toContain("CODEX_API_KEY=[redacted]");
      expect(JSON.stringify(body)).not.toContain("fixture-secret");
    } finally {
      faux.unregister();
      database.close();
    }
  });

  test("interrupts a running PI conversation", async () => {
    const database = await openFixtureDatabase();
    const faux = registerFauxProvider({
      api: "pi-test-faux-api",
      provider: "pi-test-faux",
      tokenSize: { min: 1, max: 1 },
      tokensPerSecond: 1
    });
    try {
      faux.setResponses([
        fauxAssistantMessage("slow response"),
        fauxAssistantMessage("ok")
      ]);
      insertProject(database, "demo");
      insertFauxAgent(database);
      writeFauxModelsConfig(database);
      const router = createDefaultRouter({ database });
      await request(router, "/api/pi/conversations", {
        id: "conv-interrupt",
        project_id: "demo",
      });

      const running = request(router, "/api/pi/conversations/conv-interrupt/messages", {
        prompt: "please stream slowly"
      });
      await until(() => faux.state.callCount > 0);
      const interrupt = await router.handle(new Request(
        `${BASE_URL}/api/pi/conversations/conv-interrupt/interrupt`,
        { method: "POST" }
      ));
      const result = await running;

      expect(interrupt.status).toBe(200);
      expect(await interrupt.json()).toMatchObject({ interrupted: true, conversation_id: "conv-interrupt" });
      expect(result.status).toBe(201);
      const turnEvents = await readPiConversationSse(result);
      expect(turnEvents.at(-1)).toMatchObject({
        event: "failed",
        data: {
          conversation_id: "conv-interrupt",
          error: { code: "interrupted" },
          status: "failed",
          text: ""
        }
      });
      const next = await requestAfterActiveTurn(router, "/api/pi/conversations/conv-interrupt/messages", {
        prompt: "start a fresh turn"
      });
      expect(await finalPiConversationSseData(next)).toMatchObject({
        conversation_id: "conv-interrupt",
        status: "completed",
        text: "ok"
      });
      expect(faux.state.callCount).toBe(2);
    } finally {
      faux.unregister();
      database.close();
    }
  });

  test("client cancellation detaches the SSE response without aborting or duplicating the turn", async () => {
    const database = await openFixtureDatabase();
    const faux = registerFauxProvider({ api: "pi-cancel-faux-api", provider: "pi-cancel-faux" });
    let releaseProvider = () => {};
    const providerGate = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    try {
      faux.setResponses([
        async () => {
          await providerGate;
          return fauxAssistantMessage("persist after disconnect");
        },
        fauxAssistantMessage("next turn")
      ]);
      insertProject(database, "demo");
      insertFauxAgent(database, "pi-cancel-faux");
      writeFauxModelsConfig(database, "pi-cancel-faux");
      const router = createDefaultRouter({ database });
      await request(router, "/api/pi/conversations", {
        id: "conv-cancel", project_id: "demo"
      });

      const disconnected = await request(router, "/api/pi/conversations/conv-cancel/messages", {
        prompt: "keep running"
      });
      await until(() => faux.state.callCount > 0);
      await disconnected.body?.cancel();
      const conflict = await request(router, "/api/pi/conversations/conv-cancel/messages", {
        prompt: "must not duplicate"
      });
      expect(conflict.status).toBe(409);

      releaseProvider();
      const recovered = await waitForConversationTranscript(
        router,
        "conv-cancel",
        "persist after disconnect"
      );
      expect(recovered.transcript).toEqual([
        expect.objectContaining({ role: "user", text: "keep running" }),
        expect.objectContaining({ role: "assistant", text: "persist after disconnect" })
      ]);
      expect(faux.state.callCount).toBe(1);
      const next = await requestAfterActiveTurn(router, "/api/pi/conversations/conv-cancel/messages", {
        prompt: "next"
      });
      expect(await finalPiConversationSseData(next)).toMatchObject({
        conversation_id: "conv-cancel",
        message_count: 4,
        status: "completed",
        text: "next turn"
      });
    } finally {
      faux.unregister();
      database.close();
    }
  });
});

const PNG_FIXTURE = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
  "base64"
);

function request(router: ReturnType<typeof createDefaultRouter>, path: string, body: Record<string, unknown>) {
  return router.handle(new Request(`${BASE_URL}${path}`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" }
  }));
}

async function getJson(router: ReturnType<typeof createDefaultRouter>, path: string): Promise<any> {
  const response = await router.handle(new Request(`${BASE_URL}${path}`));
  expect(response.status).toBe(200);
  return response.json();
}

function insertFauxAgent(db: RunnerDatabase, provider = "pi-test-faux"): void {
  db.sqlite.run(
    `update pi_agents set name=?, model_provider=?, model_id=?, thinking_level=?, enabled=?, updated_at=?
      where id='runner-default'`,
    ["Xuanwu Supervisor", provider, "faux-1", "off", 1, "2026-01-01T00:00:00Z"]
  );
}

function insertUpload(db: RunnerDatabase, id: string): void {
  const uploadDir = join(db.path, "..", "uploads", "fixtures");
  const storagePath = join(uploadDir, `${id}.png`);
  mkdirSync(uploadDir, { recursive: true });
  writeFileSync(storagePath, PNG_FIXTURE);
  db.sqlite.run(
    `insert into uploads (id, original_name, mime_type, size_bytes, sha256, storage_path, created_at)
     values (?, ?, ?, ?, ?, ?, ?)`,
    [id, "one.png", "image/png", PNG_FIXTURE.byteLength, "fixture-sha", storagePath, "2026-01-01T00:00:00Z"]
  );
}

function insertProject(db: RunnerDatabase, id: string, options: { autoRun?: number } = {}): void {
  db.sqlite.run(
    `insert into projects (id, name, cwd, provider, provider_config_json, auto_run, sort_order, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, id, `/tmp/${id}`, "codex", '{"capabilities":["issue_execution"]}',
      options.autoRun ?? 0, 1, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
}

function insertIssue(
  db: RunnerDatabase,
  input: { id: number; projectID: string; status?: string; title?: string }
): void {
  db.sqlite.run(
    `insert into issues (id, project_id, title, status, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?)`,
    [input.id, input.projectID, input.title ?? "Issue", input.status ?? "triage",
      "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
}

function seedManualContextEvents(db: RunnerDatabase): void {
  createManualContextEvent(db, "m1", "2026-07-06T01:01:00Z", "登录页 500，是个 bug");
  createManualContextEvent(db, "m2", "2026-07-06T01:02:00Z", "截图如下", {
    attachments: [{ kind: "image", mime: "image/png", name: "login.png" }]
  });
  createManualContextEvent(db, "m3", "2026-07-06T01:03:00Z", "请帮忙创建 issue");
}

function createManualContextEvent(
  db: RunnerDatabase,
  externalID: string,
  occurredAt: string,
  content: string,
  overrides: Record<string, unknown> = {}
): void {
  createExternalEvent(db, {
    content,
    external_id: externalID,
    normalized_message: {
      chat_id: "group-1",
      chat_type: "group",
      message_id: externalID,
      thread_id: "thread-a"
    },
    occurred_at: occurredAt,
    provider: "fixture-provider",
    raw_json: { text: content },
    received_at: occurredAt,
    source: "fixture-im",
    ...overrides
  });
}

function writeFauxModelsConfig(
  db: RunnerDatabase,
  provider = "pi-test-faux",
  modelOverride: Record<string, unknown> = {}
): void {
  const agentDir = join(db.path, "..", "pi-runtime", "agent");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "models.json"), JSON.stringify({
    providers: {
      [provider]: {
        api: `${provider}-api`,
        apiKey: "test",
        baseUrl: "http://localhost:0",
        models: [{ id: "faux-1", ...modelOverride }]
      }
    }
  }));
  if (!existsSync(join(agentDir, "models.json"))) throw new Error("models config missing");
}

function insertConversation(
  db: RunnerDatabase,
  input: { id: string; projectId: string; sessionFile: string }
): void {
  db.sqlite.run(
    `insert into pi_conversations
      (id, project_id, pi_agent_id, title, status, session_file, pi_session_id, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [input.id, input.projectId, "runner-default", "History", "active", input.sessionFile,
      input.id, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
}

function writeConversationSession(
  db: RunnerDatabase,
  id: string,
  entries: Array<Record<string, unknown>>
): string {
  const dir = join(db.path, "..", "pi-runtime", "sessions");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `fixture_${id}.jsonl`);
  writeFileSync(file, entries.map((entry) => JSON.stringify(entry)).join("\n"));
  return file;
}

function sessionMessage(id: string, role: string, text: string): Record<string, unknown> {
  return {
    type: "message",
    id,
    timestamp: "2026-01-01T00:00:00Z",
    message: { role, content: [{ type: "text", text }] }
  };
}

function readSessionHeader(path: string): Record<string, unknown> {
  const firstLine = readFileSync(path, "utf8").split("\n")[0] ?? "{}";
  const value = JSON.parse(firstLine);
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

async function until(check: () => boolean): Promise<void> {
  for (let index = 0; index < 50; index += 1) {
    if (check()) return;
    await Bun.sleep(10);
  }
  throw new Error("condition timed out");
}

async function requestAfterActiveTurn(
  router: ReturnType<typeof createDefaultRouter>,
  path: string,
  body: Record<string, unknown>
): Promise<Response> {
  for (let index = 0; index < 50; index += 1) {
    const response = await request(router, path, body);
    if (response.status !== 409) return response;
    await Bun.sleep(10);
  }
  throw new Error("active PI turn did not clean up");
}

async function waitForConversationTranscript(
  router: ReturnType<typeof createDefaultRouter>,
  conversationID: string,
  expectedText: string
): Promise<Record<string, any>> {
  for (let index = 0; index < 50; index += 1) {
    const response = await router.handle(new Request(
      `${BASE_URL}/api/pi/conversations/${encodeURIComponent(conversationID)}`
    ));
    const body = await response.json() as Record<string, any>;
    const transcript = Array.isArray(body.transcript) ? body.transcript : [];
    if (transcript.some((item) => item?.text === expectedText)) return body;
    await Bun.sleep(10);
  }
  throw new Error(`persisted PI transcript did not include: ${expectedText}`);
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
