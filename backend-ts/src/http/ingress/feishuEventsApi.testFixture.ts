import { afterEach } from "bun:test";
import { createCipheriv, createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildConfig } from "../../config/env.ts";
import { openDatabase, type RunnerDatabase } from "../../db/database.ts";
import { EventBus } from "../../events/bus.ts";
import { createRequestHandler, createDefaultRouter } from "../server.ts";
import type { createFeishuAgentBridge } from "../../integrations/feishu/feishuAgentBridge.ts";
import type { LlmIntakeModel, LlmIntakeRequest } from "../../pi/intake/llmIntake.ts";
import { useDatabaseCleanup } from "../../testing/harness.ts";



export function createTestFixture() {
  const trackDatabase = useDatabaseCleanup();

  const BASE_URL = "http://127.0.0.1:3008";

  const ENCRYPT_KEY = "fixture-encrypt-key";

  const tempRoots: string[] = [];

  afterEach(async () => {
    while (tempRoots.length > 0) {
      const root = tempRoots.pop();
      if (root) await rm(root, { recursive: true, force: true });
    }
  });

  async function fixtureHandler(options: {
    agentBridge?: ReturnType<typeof createFeishuAgentBridge>;
    encryptKey?: string;
    feishuIntakeModel?: LlmIntakeModel;
    feishuIntakePolicy?: Record<string, unknown>;
    projectMappings?: string;
    runnerAuthToken?: string;
  }) {
    const root = await mkdtemp(join(tmpdir(), "xuanwu-feishu-http-"));
    tempRoots.push(root);
    const bus = new EventBus();
    const database = await openDatabase({ stateDir: join(root, "state") }).then(trackDatabase);
    const config = buildConfig({
      authToken: options.runnerAuthToken ?? "",
      feishuAppId: "cli_app_id",
      feishuAppSecret: "app-secret-value",
      feishuEncryptKey: options.encryptKey ?? "",
      feishuProjectMappings: options.projectMappings ?? "",
      feishuVerificationToken: "verify-token"
    });
    const router = createDefaultRouter({
      bus,
      config,
      database,
      feishuAgentBridge: options.agentBridge,
      feishuIntakeModel: options.feishuIntakeModel,
      feishuIntakePolicy: options.feishuIntakePolicy
    } as Parameters<typeof createDefaultRouter>[0] & Record<string, unknown>);
    return { bus, database, handle: createRequestHandler(router, config.authToken) };
  }

  async function postFeishu(handle: (request: Request) => Promise<Response>, body: unknown, headers = new Headers()): Promise<Response> {
    headers.set("content-type", "application/json");
    return handle(new Request(`${BASE_URL}/api/integrations/feishu/events`, {
      body: JSON.stringify(body),
      headers,
      method: "POST"
    }));
  }

  function signedHeaders(rawBody: string): Headers {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonce = "nonce-1";
    const signature = createHash("sha256").update(`${timestamp}${nonce}${ENCRYPT_KEY}${rawBody}`).digest("hex");
    return new Headers({
      "x-lark-request-nonce": nonce,
      "x-lark-request-timestamp": timestamp,
      "x-lark-signature": signature
    });
  }

  function messageEvent(input: { text?: string; token: string }): Record<string, unknown> {
    return {
      header: { event_id: "event-v2-1", event_type: "im.message.receive_v1", token: input.token },
      event: {
        message: {
          chat_id: "oc_group",
          chat_type: "group",
          content: JSON.stringify({ text: input.text ?? "@PI implement it" }),
          create_time: "1781244167890",
          message_id: "om_message_1"
        },
        sender: { sender_id: { open_id: "ou_open_1", user_id: "ou_user_1" }, sender_type: "user", tenant_key: "tenant_a" }
      },
      schema: "2.0"
    };
  }

  function seedProject(db: RunnerDatabase, id: string): void {
    db.sqlite.run(
      `insert into projects (id, name, cwd, provider, created_at, updated_at)
      values (?, ?, ?, ?, ?, ?)`,
      [id, id, `/tmp/${id}`, "codex", "2026-07-09T00:00:00Z", "2026-07-09T00:00:00Z"]
    );
  }

  function feishuTaskIntakeModel(): LlmIntakeModel {
    return (request) => {
      const event = request.input.context_bundle.raw_event_summaries[0];
      return {
        ignored_groups: [],
        inbox_items: [{
          actor_refs: [event.actor],
          confidence: 0.93,
          evidence_refs: [event.evidence_ref],
          intents: { primary: "bug_report", secondary: ["reply_needed"], tags: ["feishu"] },
          suggested_actions: ["issue.create"],
          summary: "Feishu 用户反馈 demo 登录页 500，需要进入通用 proposal 流。",
          target_hints: [{ confidence: 0.95, id: "demo", kind: "project", reason: "intake extracted explicit project" }],
          title: "登录页 500",
          urgency: "medium"
        }]
      };
    };
  }

  function feishuIgnoredIntakeModel(): LlmIntakeModel {
    return (request: LlmIntakeRequest) => ({
      ignored_groups: [{
        confidence: 0.91,
        evidence_refs: request.input.context_bundle.evidence_refs,
        reason: "casual_chat_no_task",
        summary: "普通聊天，不需要创建任务或提案。"
      }],
      inbox_items: []
    });
  }

  function encryptedChallengePayload(): string {
    return encryptFeishuPayload(JSON.stringify({ challenge: "encrypted-challenge", token: "verify-token", type: "url_verification" }));
  }

  function encryptedMessagePayload(): string {
    return encryptFeishuPayload(JSON.stringify(messageEvent({ token: "verify-token" })));
  }

  function encryptFeishuPayload(plainText: string): string {
    const iv = Buffer.alloc(16, 7);
    const key = createHash("sha256").update(ENCRYPT_KEY).digest();
    const cipher = createCipheriv("aes-256-cbc", key, iv);
    return Buffer.concat([iv, cipher.update(plainText, "utf8"), cipher.final()]).toString("base64");
  }
  return { trackDatabase, BASE_URL, ENCRYPT_KEY, tempRoots, fixtureHandler, postFeishu, signedHeaders, messageEvent, seedProject, feishuTaskIntakeModel, feishuIgnoredIntakeModel, encryptedChallengePayload, encryptedMessagePayload, encryptFeishuPayload };
}
export type TestFixture = ReturnType<typeof createTestFixture>;
