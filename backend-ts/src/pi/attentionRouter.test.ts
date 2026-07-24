import { describe, expect, test } from "bun:test";
import { decidePiAttention } from "./attentionRouter.ts";

const MESSAGE = {
  chat_id: "oc_group",
  mentions: [{ id: "ou_bot", name: "PI" }],
  message_id: "om_1",
  sender_id: "ou_user_1",
  sender_open_id: "ou_open_1",
  text: "@PI 帮我实现这个折叠面板功能"
};

describe("PI structural attention boundary", () => {
  test("ignores messages without a trusted channel, user, or bot mention", () => {
    expect(decidePiAttention({
      message: { ...MESSAGE, mentions: [], text: "今晚吃啥？" }
    })).toMatchObject({
      decision: "ignore",
      needs_project: false,
      project_id: "",
      reason: "no_trusted_attention",
      should_create_issue_proposal: false,
      signals: []
    });
  });

  test("forwards every trusted message to PI without classifying natural-language intent", () => {
    for (const text of [
      "你能帮我做什么",
      "retry",
      "重试吧",
      "帮我修复报错",
      "/issue 在 demo 修复问题",
      "收到，我稍后看。"
    ]) {
      const decision = decidePiAttention({
        message: { ...MESSAGE, mentions: [], text },
        policy: { allowedChatIds: ["oc_group"] },
        projects: [{ id: "demo", name: "Demo" }]
      });
      expect(decision).toMatchObject({
        decision: "inbox_only",
        needs_project: false,
        project_id: "",
        project_source: "none",
        reason: "trusted_message_forwarded_to_pi",
        should_create_issue_proposal: false,
        signals: ["allowed_chat"]
      });
      expect(JSON.stringify(decision)).not.toContain("keyword");
    }
  });

  test("allows an explicit bot mention even outside configured chat mappings", () => {
    expect(decidePiAttention({
      message: MESSAGE,
      projects: [{ id: "demo", name: "Demo" }]
    })).toMatchObject({
      decision: "inbox_only",
      project_id: "",
      signals: ["bot_mentioned"]
    });
  });

  test("allows configured users structurally without assigning a project", () => {
    expect(decidePiAttention({
      message: { ...MESSAGE, chat_id: "oc_other", mentions: [], text: "anything" },
      policy: {
        allowedUserIds: ["ou_open_1"],
        projectMappings: [{ projectId: "demo", userId: "ou_open_1" }]
      }
    })).toMatchObject({
      decision: "inbox_only",
      project_id: "",
      project_source: "none",
      signals: ["allowed_user"]
    });
  });
});
