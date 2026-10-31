import { expect } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { type RunnerDatabase } from "../../db/database.ts";
import { createExternalEvent } from "../../db/repositories/externalEvents.ts";
import { getPiConversation, listPiActionEvents } from "../../db/repositories/pi.ts";
import type { ExecutorProvider, ProviderRunInput } from "../../providers/types.ts";
import { EventBus } from "../../events/bus.ts";
import { finalPiConversationSseData } from "./piConversationSse.testSupport.ts";
import { createDefaultRouter } from "../server.ts";
import { listBuiltinAssistantTools } from "../../pi/tools/builtinToolRegistry.ts";
import { FIXTURE_TIME, insertProject, insertRow, useTestDatabase, waitFor } from "../../testing/harness.ts";
import { useFauxPi, type FauxPiOptions } from "../../testing/fauxPi.ts";

export type Router = ReturnType<typeof createDefaultRouter>;

export function createTestFixture() {
  const BASE_URL = "http://127.0.0.1:3008";

  const openFixtureDatabase = useTestDatabase();

  const fauxPi = useFauxPi("pi-conversation");

  const PNG_FIXTURE = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAEElEQVR4AQEFAPr/AP////8J+wP9o9FJCgAAAABJRU5ErkJggg==",
    "base64"
  );

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

  function toolUse(name: string, args: Parameters<typeof fauxToolCall>[1]) {
    return fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
  }

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
  return { BASE_URL, openFixtureDatabase, fauxPi, PNG_FIXTURE, piFixture, post, getJson, toolUse, capabilityInvoke, actionEvents, firstActionEventPayload, sessionCwd, insertUpload, seedManualContextEvents, imageSummary, isImageContent, FakeExecutorProvider };
}
export type TestFixture = ReturnType<typeof createTestFixture>;
