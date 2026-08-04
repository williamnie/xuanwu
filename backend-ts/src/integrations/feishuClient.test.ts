import { describe, expect, test } from "bun:test";
import { buildFeishuConnectorConfig } from "./feishu.ts";
import { FeishuClientError, createFeishuMessageClient } from "./feishuClient.ts";

describe("Feishu message client", () => {
  test("fetches and caches tenant access token before sending text", async () => {
    const calls: Array<{ body: string; url: string }> = [];
    const client = createFeishuMessageClient({
      config: config(),
      fetch: async (input, init) => {
        calls.push({ body: String(init?.body ?? ""), url: String(input) });
        if (String(input).includes("tenant_access_token")) {
          return jsonResponse({ code: 0, expire: 7200, tenant_access_token: "tenant-token-1" });
        }
        expect(init?.headers).toMatchObject({ Authorization: "Bearer tenant-token-1" });
        return jsonResponse({ code: 0, data: { message_id: "om_sent_1" } });
      }
    });

    const first = await client.sendTextMessage({ receiveId: "oc_group", receiveIdType: "chat_id", text: "hello" });
    const second = await client.sendTextMessage({ receiveId: "ou_open_1", receiveIdType: "open_id", text: "hi" });

    expect(first).toEqual({ messageId: "om_sent_1" });
    expect(second).toEqual({ messageId: "om_sent_1" });
    expect(calls.map((call) => call.url)).toEqual([
      "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
      "https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id",
      "https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id"
    ]);
    expect(JSON.parse(calls[1].body)).toMatchObject({ receive_id: "oc_group", msg_type: "text" });
  });

  test("sends interactive card payloads with Feishu interactive message type", async () => {
    const calls: Array<{ body: string; url: string }> = [];
    const client = createFeishuMessageClient({
      config: config(),
      fetch: async (input, init) => {
        calls.push({ body: String(init?.body ?? ""), url: String(input) });
        if (String(input).includes("tenant_access_token")) {
          return jsonResponse({ code: 0, expire: 7200, tenant_access_token: "tenant-token-1" });
        }
        return jsonResponse({ code: 0, data: { message_id: "om_card_1" } });
      }
    });

    const result = await client.sendInteractiveCard?.({
      card: { header: { title: { content: "请选择 Runner 项目", tag: "plain_text" } } },
      receiveId: "oc_group",
      receiveIdType: "chat_id"
    });

    expect(result).toEqual({ messageId: "om_card_1" });
    expect(JSON.parse(calls[1].body)).toMatchObject({
      msg_type: "interactive",
      receive_id: "oc_group"
    });
    expect(JSON.parse(JSON.parse(calls[1].body).content)).toMatchObject({
      header: { title: { content: "请选择 Runner 项目" } }
    });
  });

  test("adds a message reaction with Feishu emoji type", async () => {
    const calls: Array<{ body: string; url: string }> = [];
    const client = createFeishuMessageClient({
      config: config(),
      fetch: async (input, init) => {
        calls.push({ body: String(init?.body ?? ""), url: String(input) });
        if (String(input).includes("tenant_access_token")) {
          return jsonResponse({ code: 0, expire: 7200, tenant_access_token: "tenant-token-1" });
        }
        expect(init?.headers).toMatchObject({ Authorization: "Bearer tenant-token-1" });
        return jsonResponse({ code: 0, data: { reaction_id: "mr_ack_1" } });
      }
    });

    const result = await client.addMessageReaction?.({
      emojiType: "OK",
      messageId: "om_user_message_1"
    });

    expect(result).toEqual({ reactionId: "mr_ack_1" });
    expect(calls.map((call) => call.url)).toEqual([
      "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
      "https://open.feishu.cn/open-apis/im/v1/messages/om_user_message_1/reactions"
    ]);
    expect(JSON.parse(calls[1].body)).toEqual({
      reaction_type: { emoji_type: "OK" }
    });
  });

  test("classifies permission failures without leaking app secret", async () => {
    const client = createFeishuMessageClient({
      config: config(),
      fetch: async (input) => String(input).includes("tenant_access_token")
        ? jsonResponse({ code: 0, expire: 7200, tenant_access_token: "tenant-token-1" })
        : jsonResponse({ code: 99991663, msg: "permission denied app-secret-value" }, 401)
    });

    const error = await captureError(() => client.sendTextMessage({
      receiveId: "oc_group",
      receiveIdType: "chat_id",
      text: "hello"
    }));

    expect(error).toBeInstanceOf(FeishuClientError);
    expect((error as FeishuClientError).kind).toBe("auth");
    expect((error as FeishuClientError).retryAfterSeconds).toBeUndefined();
    expect(error.message).toContain("permission denied");
    expect(error.message).not.toContain("app-secret-value");
  });

  test("surfaces Feishu rate limit retry_after", async () => {
    const client = createFeishuMessageClient({
      config: config(),
      fetch: async (input) => String(input).includes("tenant_access_token")
        ? jsonResponse({ code: 0, expire: 7200, tenant_access_token: "tenant-token-1" })
        : jsonResponse({ code: 99991400, msg: "rate limited" }, 429, { "retry-after": "45" })
    });

    const error = await captureError(() => client.sendTextMessage({
      receiveId: "oc_group",
      receiveIdType: "chat_id",
      text: "hello"
    }));

    expect(error).toBeInstanceOf(FeishuClientError);
    expect((error as FeishuClientError).kind).toBe("rate_limited");
    expect((error as FeishuClientError).retryAfterSeconds).toBe(45);
  });

  test("classifies network failures as temporary", async () => {
    const client = createFeishuMessageClient({
      config: config(),
      fetch: async (input) => {
        if (String(input).includes("tenant_access_token")) {
          return jsonResponse({ code: 0, expire: 7200, tenant_access_token: "tenant-token-1" });
        }
        throw new Error("socket closed");
      }
    });

    const error = await captureError(() => client.sendTextMessage({
      receiveId: "oc_group",
      receiveIdType: "chat_id",
      text: "hello"
    }));

    expect(error).toBeInstanceOf(FeishuClientError);
    expect((error as FeishuClientError).kind).toBe("temporary");
    expect(error.message).toContain("socket closed");
  });

  test("manual smoke can send with explicit Feishu env", async () => {
    if (Bun.env.FEISHU_SMOKE_SEND !== "1") return;
    const receiveId = Bun.env.FEISHU_SMOKE_RECEIVE_ID?.trim() ?? "";
    expect(receiveId).not.toBe("");
    const client = createFeishuMessageClient({ config: buildFeishuConnectorConfig(Bun.env) });

    const result = await client.sendTextMessage({
      receiveId,
      receiveIdType: Bun.env.FEISHU_SMOKE_RECEIVE_ID_TYPE?.trim() || "chat_id",
      text: `xuanwu Feishu smoke ${new Date().toISOString()}`
    });

    expect(result.messageId).not.toBe("");
  });
});

function config() {
  return buildFeishuConnectorConfig({
    feishuAppId: "cli_app_id",
    feishuAppSecret: "app-secret-value",
    feishuVerificationToken: "verify-token"
  });
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json", ...headers },
    status
  });
}

async function captureError(fn: () => Promise<unknown>): Promise<Error> {
  try {
    await fn();
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected function to throw");
}
