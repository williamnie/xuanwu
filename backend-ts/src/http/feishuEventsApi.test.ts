import { afterEach, describe, expect, test } from "bun:test";
import { createCipheriv, createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildConfig } from "../config/env.ts";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { EventBus } from "../events/bus.ts";
import { createRequestHandler, createDefaultRouter } from "./server.ts";
import type { createFeishuAgentBridge } from "../integrations/feishuAgentBridge.ts";

const BASE_URL = "http://127.0.0.1:3008";
const ENCRYPT_KEY = "fixture-encrypt-key";
const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) await rm(root, { recursive: true, force: true });
  }
});

describe("Feishu events endpoint", () => {
  test("responds to URL verification challenge without requiring runner bearer auth", async () => {
    const { bus, database, handle } = await fixtureHandler({ runnerAuthToken: "runner-secret" });
    const subscription = bus.subscribe();
    try {
      const response = await postFeishu(handle, { challenge: "challenge-code", token: "verify-token", type: "url_verification" });
      const received = await subscription.next();
      const challenge = await subscription.next();

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ challenge: "challenge-code" });
      expect(received).toMatchObject({ type: "integration.feishu.audit" });
      expect(JSON.parse(String(challenge?.payload))).toMatchObject({
        connector: "feishu",
        outcome: "challenge",
        reason: "challenge_verified"
      });
    } finally {
      subscription.close();
      database.close();
    }
  });

  test("normalizes valid message events and publishes redacted audit summary", async () => {
    const { bus, database, handle } = await fixtureHandler({
      encryptKey: ENCRYPT_KEY,
      projectMappings: "chat:oc_group=demo"
    });
    const subscription = bus.subscribe();
    const body = messageEvent({ token: "verify-token" });
    const rawBody = JSON.stringify(body);
    try {
      const response = await postFeishu(handle, body, signedHeaders(rawBody));
      const received = await subscription.next();
      const accepted = await subscription.next();
      const payload = JSON.parse(String(accepted?.payload));
      const text = JSON.stringify({ received, accepted, body: await response.json() });

      expect(response.status).toBe(202);
      expect(payload).toMatchObject({
        connector: "feishu",
        dedupe_key: "feishu:message:om_message_1",
        normalized_summary: {
          attachment_count: 0,
          chat_id: "oc_group",
          message_id: "om_message_1",
          project_id: "",
          sender_type: "user",
          text_length: 16
        },
        outcome: "accepted",
        reason: "message_normalized"
      });
      expect(text).not.toContain("verify-token");
      expect(text).not.toContain(ENCRYPT_KEY);
    } finally {
      subscription.close();
      database.close();
    }
  });

  test("passes accepted callback messages to the Feishu agent bridge", async () => {
    const bridgeCalls: Array<{ messageId: string; projectId: unknown; text: string }> = [];
    const bridge: ReturnType<typeof createFeishuAgentBridge> = {
      handle: async ({ event, ingest }) => {
        bridgeCalls.push({
          messageId: event.message_id,
          projectId: ingest.normalized_summary.project_id,
          text: event.text
        });
        return { reason: "agent_reply_sent", replied: true };
      },
      handleProjectSelectionAction: async () => ({ reason: "unused", replied: false })
    };
    const { database, handle } = await fixtureHandler({
      agentBridge: bridge,
      projectMappings: "chat:oc_group=demo"
    });
    try {
      const response = await postFeishu(handle, messageEvent({ token: "verify-token" }));

      expect(response.status).toBe(202);
      expect(bridgeCalls).toEqual([{
        messageId: "om_message_1",
        projectId: "",
        text: "@PI implement it"
      }]);
    } finally {
      database.close();
    }
  });

  test("responds to encrypted URL verification when encrypt key is configured", async () => {
    const { bus, database, handle } = await fixtureHandler({ encryptKey: ENCRYPT_KEY });
    const subscription = bus.subscribe();
    const encrypted = encryptedChallengePayload();
    try {
      const response = await postFeishu(handle, { encrypt: encrypted });
      await subscription.next();
      const challenge = await subscription.next();

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ challenge: "encrypted-challenge" });
      expect(JSON.parse(String(challenge?.payload))).toMatchObject({
        encrypted: true,
        outcome: "challenge",
        reason: "challenge_verified"
      });
    } finally {
      subscription.close();
      database.close();
    }
  });

  test("returns diagnostic error for encrypted callbacks without encrypt key", async () => {
    const { bus, database, handle } = await fixtureHandler({});
    const subscription = bus.subscribe();
    try {
      const response = await postFeishu(handle, { encrypt: encryptedMessagePayload() });
      await subscription.next();
      const rejected = await subscription.next();

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ message: "feishu encrypted callback requires FEISHU_ENCRYPT_KEY" });
      expect(JSON.parse(String(rejected?.payload))).toMatchObject({
        outcome: "rejected",
        reason: "encrypted_event_without_encrypt_key"
      });
    } finally {
      subscription.close();
      database.close();
    }
  });

  test("rejects invalid verification token and records a safe refusal reason", async () => {
    const { bus, database, handle } = await fixtureHandler({});
    const subscription = bus.subscribe();
    try {
      const response = await postFeishu(handle, messageEvent({ token: "wrong-token" }));
      await subscription.next();
      const rejected = await subscription.next();
      const text = JSON.stringify({ audit: rejected, body: await response.json() });

      expect(response.status).toBe(401);
      expect(JSON.parse(String(rejected?.payload))).toMatchObject({
        connector: "feishu",
        outcome: "rejected",
        reason: "invalid_verification_token"
      });
      expect(text).not.toContain("verify-token");
      expect(text).not.toContain("wrong-token");
    } finally {
      subscription.close();
      database.close();
    }
  });

  test("rejects invalid signatures before accepting encrypted-policy events", async () => {
    const { bus, database, handle } = await fixtureHandler({ encryptKey: ENCRYPT_KEY });
    const subscription = bus.subscribe();
    try {
      const response = await postFeishu(handle, messageEvent({ token: "verify-token" }), new Headers({
        "x-lark-request-nonce": "nonce-1",
        "x-lark-request-timestamp": String(Math.floor(Date.now() / 1000)),
        "x-lark-signature": "bad-signature"
      }));
      await subscription.next();
      const rejected = await subscription.next();
      const text = JSON.stringify({ audit: rejected, body: await response.json() });

      expect(response.status).toBe(401);
      expect(JSON.parse(String(rejected?.payload))).toMatchObject({
        outcome: "rejected",
        reason: "invalid_signature"
      });
      expect(text).not.toContain(ENCRYPT_KEY);
      expect(text).not.toContain("verify-token");
    } finally {
      subscription.close();
      database.close();
    }
  });

  test("returns a diagnostic error when connector config is incomplete", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-runner-feishu-http-"));
    tempRoots.push(root);
    const database = await openDatabase({ stateDir: join(root, "state") });
    const config = buildConfig({ feishuAppId: "cli_app_id" });
    const router = createDefaultRouter({ config, database });
    try {
      const response = await postFeishu(createRequestHandler(router, ""), {
        challenge: "challenge-code",
        token: "verify-token",
        type: "url_verification"
      });

      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ message: "feishu connector is not configured" });
    } finally {
      database.close();
    }
  });
});

async function fixtureHandler(options: {
  agentBridge?: ReturnType<typeof createFeishuAgentBridge>;
  encryptKey?: string;
  projectMappings?: string;
  runnerAuthToken?: string;
}) {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-feishu-http-"));
  tempRoots.push(root);
  const bus = new EventBus();
  const database = await openDatabase({ stateDir: join(root, "state") });
  const config = buildConfig({
    authToken: options.runnerAuthToken ?? "",
    feishuAppId: "cli_app_id",
    feishuAppSecret: "app-secret-value",
    feishuEncryptKey: options.encryptKey ?? "",
    feishuProjectMappings: options.projectMappings ?? "",
    feishuVerificationToken: "verify-token"
  });
  const router = createDefaultRouter({ bus, config, database, feishuAgentBridge: options.agentBridge });
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

function messageEvent(input: { token: string }): Record<string, unknown> {
  return {
    header: { event_id: "event-v2-1", event_type: "im.message.receive_v1", token: input.token },
    event: {
      message: {
        chat_id: "oc_group",
        chat_type: "group",
        content: JSON.stringify({ text: "@PI implement it" }),
        create_time: "1781244167890",
        message_id: "om_message_1"
      },
      sender: { sender_id: { open_id: "ou_open_1", user_id: "ou_user_1" }, sender_type: "user", tenant_key: "tenant_a" }
    },
    schema: "2.0"
  };
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
