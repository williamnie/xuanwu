import { describe, expect, test } from "bun:test";
import {
  buildFeishuProjectSelectionCard,
  normalizeFeishuProjectSelectionAction
} from "./feishuProjectSelection.ts";

describe("Feishu project selection card", () => {
  test("builds a safe interactive card with project choices", () => {
    const card = buildFeishuProjectSelectionCard({
      candidates: [
        { id: "codex-issue-runner", name: "Codex Issue Runner" },
        { id: "demo", name: "Demo Project" }
      ],
      originalPrompt: "开始做吧 CODEX_API_KEY=secret /Users/xiaobei/private",
      selectionId: "fps_card_1"
    });
    const text = JSON.stringify(card);

    expect(text).toContain("请选择 Runner 项目");
    expect(text).toContain("codex-issue-runner");
    expect(text).toContain("fps_card_1");
    expect(text).toContain("feishu_project_select");
    expect(text).not.toContain("secret");
    expect(text).not.toContain("/Users/xiaobei/private");
  });

  test("normalizes Feishu card action callback values without leaking raw payload", () => {
    const action = normalizeFeishuProjectSelectionAction({
      event: {
        action: {
          value: { action: "feishu_project_select", project_id: "demo", selection_id: "fps_card_1" }
        },
        context: { open_chat_id: "oc_group", open_message_id: "om_card_1" },
        operator: { operator_id: { open_id: "ou_open_1", user_id: "ou_user_1" } }
      },
      header: { event_id: "evt_1", event_type: "card.action.trigger" },
      schema: "2.0"
    });

    expect(action).toEqual({
      action_id: "evt_1",
      chat_id: "oc_group",
      message_id: "om_card_1",
      project_id: "demo",
      selection_id: "fps_card_1",
      user_id: "ou_user_1",
      user_open_id: "ou_open_1"
    });
  });
});
