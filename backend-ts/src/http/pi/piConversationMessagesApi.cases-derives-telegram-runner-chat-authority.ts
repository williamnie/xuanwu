import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { getPiIssueCompletionWatch, listPiActions } from "../../db/repositories/pi.ts";
import { runPiConversationPrompt } from "./piConversationApi.ts";
import { finalPiConversationSseData, readPiConversationSse } from "./piConversationSse.testSupport.ts";
import { FIXTURE_TIME, insertIssue, insertRow, waitFor } from "../../testing/harness.ts";
import type { TestFixture } from "./piConversationMessagesApi.testFixture.ts";

export function registerDerivesTelegramRunnerChatAuthorityCases(testScope: TestFixture) {
  const { piFixture, post, getJson, toolUse, firstActionEventPayload } = testScope;
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
}
