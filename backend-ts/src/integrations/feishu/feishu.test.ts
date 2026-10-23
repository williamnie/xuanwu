import { describe, expect, test } from "bun:test";
import {
  FEISHU_CONNECTOR_V0,
  buildFeishuConnectorConfig,
  feishuConnectorStatus,
  feishuExternalEventInput,
  normalizeFeishuMessageEvent,
  projectIDForFeishuMessage,
  redactFeishuConnectorConfig
} from "./feishu.ts";

describe("Feishu IM connector contract", () => {
  test("defaults to disabled without secrets and exposes only redacted status", () => {
    const config = buildFeishuConnectorConfig({});
    const status = feishuConnectorStatus(config);

    expect(config).toMatchObject({
      allowedChatIds: [],
      allowedUserIds: [],
      appId: "",
      appSecret: "",
      defaultChatId: "",
      defaultUserId: "",
      encryptKey: "",
      projectMappings: [],
      receiveMode: "websocket",
      verificationToken: ""
    });
    expect(feishuConnectorStatus(buildFeishuConnectorConfig({ FEISHU_APP_ID: "cli_app_id" }))).toMatchObject({
      enabled: false,
      missing_required: ["FEISHU_APP_SECRET"],
      status: "misconfigured",
      summary: {
        error: "missing FEISHU_APP_SECRET",
        state: "error"
      }
    });
    expect(status).toEqual({
      id: "feishu",
      label: "Feishu IM",
      enabled: false,
      status: "disabled",
      settings_mode: "settings_page_or_local_config",
      receive_mode: "websocket",
      supported_events: ["message.text", "message.mention"],
      attachment_policy: "metadata_only",
      auto_reply: false,
      secrets: {
        app_id: { configured: false },
        app_secret: { configured: false },
        verification_token: { configured: false, optional: true },
        encrypt_key: { configured: false, optional: true }
      },
      allowed_chat_count: 0,
      allowed_user_count: 0,
      project_mapping_count: 0,
      missing_required: ["FEISHU_APP_ID", "FEISHU_APP_SECRET"],
      summary: {
        callback_path: "/api/integrations/feishu/events",
        configured: false,
        error: "",
        public_url_required: false,
        receive_enabled: false,
        receive_mode: "websocket",
        reply_mode: "draft",
        state: "disabled"
      }
    });
  });

  test("parses env config, mappings, and redacts all secret values", () => {
    const config = buildFeishuConnectorConfig({
      FEISHU_ALLOWED_CHAT_IDS: "oc_a, oc_b",
      FEISHU_ALLOWED_USER_IDS: "ou_1",
      FEISHU_APP_ID: "cli_app_id",
      FEISHU_APP_SECRET: "app-secret-value",
      FEISHU_DEFAULT_CHAT_ID: "oc_default",
      FEISHU_DEFAULT_USER_ID: "ou_default",
      FEISHU_ENCRYPT_KEY: "encrypt-secret-value",
      FEISHU_PROJECT_MAPPINGS: "chat:oc_a=xuanwu,user:ou_1=ops-runner",
      FEISHU_RECEIVE_MODE: "callback",
      FEISHU_VERIFICATION_TOKEN: "verify-secret-value"
    });
    const redacted = JSON.stringify(redactFeishuConnectorConfig(config));

    expect(config.allowedChatIds).toEqual(["oc_a", "oc_b"]);
    expect(config.allowedUserIds).toEqual(["ou_1"]);
    expect(config.defaultChatId).toBe("oc_default");
    expect(config.defaultUserId).toBe("ou_default");
    expect(config.projectMappings).toEqual([
      { chatId: "oc_a", projectId: "xuanwu" },
      { projectId: "ops-runner", userId: "ou_1" }
    ]);
    expect(config.receiveMode).toBe("callback");
    expect(feishuConnectorStatus(config)).toMatchObject({
      enabled: true,
      receive_mode: "callback",
      status: "configured",
      allowed_chat_count: 2,
      allowed_user_count: 1,
      project_mapping_count: 2,
      missing_required: [],
      secrets: {
        app_id: { configured: true },
        app_secret: { configured: true },
        verification_token: { configured: true },
        encrypt_key: { configured: true, optional: true }
      }
    });
    expect(redacted).not.toContain("app-secret-value");
    expect(redacted).not.toContain("encrypt-secret-value");
    expect(redacted).not.toContain("verify-secret-value");
  });

  test("normalizes text mention events and prepares external_events input", () => {
    const config = buildFeishuConnectorConfig({
      FEISHU_APP_ID: "cli_app_id",
      FEISHU_APP_SECRET: "app-secret-value",
      FEISHU_PROJECT_MAPPINGS: "chat:oc_group=xuanwu",
      FEISHU_VERIFICATION_TOKEN: "verify-secret-value"
    });
    const event = normalizeFeishuMessageEvent({
      event_id: "event-v2-1",
      message: {
        chat_id: "oc_group",
        chat_type: "group",
        content: JSON.stringify({ text: "@PI 帮我实现这个折叠面板功能" }),
        create_time: "1781244167890",
        mentions: [{ id: "ou_bot", name: "PI", tenant_key: "tenant_a" }],
        message_id: "om_message_1",
        parent_id: "om_parent_1",
        root_id: "om_root_1"
      },
      sender: {
        sender_id: { open_id: "ou_open_1", user_id: "ou_user_1" },
        sender_type: "user",
        tenant_key: "tenant_a"
      }
    }, { rawEventRef: "sha256:raw-event" });

    expect(event).toEqual({
      attachments: [],
      chat_id: "oc_group",
      chat_type: "group",
      dedupe_key: "feishu:message:om_message_1",
      mentions: [{ id: "ou_bot", name: "PI", tenant_key: "tenant_a" }],
      message_id: "om_message_1",
      raw_event_ref: "sha256:raw-event",
      root_id: "om_root_1",
      sender: {
        id: "ou_user_1",
        open_id: "ou_open_1",
        tenant_key: "tenant_a",
        type: "user"
      },
      source_id: "feishu:message:om_message_1",
      text: "@PI 帮我实现这个折叠面板功能",
      thread_id: "om_parent_1",
      timestamp: "2026-06-12T06:02:47.890Z"
    });
    expect(projectIDForFeishuMessage(config, event)).toBe("");
    expect(feishuExternalEventInput(event, { projectId: projectIDForFeishuMessage(config, event) })).toMatchObject({
      actor: "feishu:user:ou_user_1",
      content: "@PI 帮我实现这个折叠面板功能",
      dedupe_key: "feishu:message:om_message_1",
      external_id: "om_message_1",
      project_hint: "",
      raw_payload_ref: "sha256:raw-event",
      received_at: "2026-06-12T06:02:47.890Z",
      source: "feishu",
      trust_level: "untrusted"
    });
  });

  test("keeps image attachments as metadata only and documents callback gates", () => {
    const event = normalizeFeishuMessageEvent({
      event_id: "event-v2-image",
      message: {
        attachments: [{ file_key: "img_v2_abc", file_name: "screen.png", file_size: 2048, image_key: "img_v2_abc", mime_type: "image/png" }],
        chat_id: "oc_group",
        chat_type: "group",
        content: { text: "看这张图" },
        create_time: "1781234567890",
        message_id: "om_image_1"
      },
      sender: { sender_id: { user_id: "ou_user_1" }, sender_type: "user" }
    });

    expect(event.attachments).toEqual([{
      file_key: "img_v2_abc",
      mime_type: "image/png",
      name: "screen.png",
      size: 2048,
      type: "image"
    }]);
    expect(FEISHU_CONNECTOR_V0).toEqual({
      auto_reply: false,
      callback_requirements: {
        challenge: "required",
        encryption: "supported_optional",
        signature: "required"
      },
      supported_events: ["message.text", "message.mention"],
      attachment_policy: "metadata_only"
    });
  });
});
