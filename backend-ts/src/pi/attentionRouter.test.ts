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

describe("PI attention router v0", () => {
  test("ignores noise messages without creating an issue proposal decision", () => {
    const decision = decidePiAttention({
      message: { ...MESSAGE, mentions: [], text: "今晚吃啥？" },
      projects: []
    });

    expect(decision).toMatchObject({
      decision: "ignore",
      needs_project: false,
      project_id: "",
      reason: "no_attention_signal",
      should_create_issue_proposal: false
    });
    expect(decision.evidence).toEqual([
      expect.objectContaining({ kind: "policy", reason: "no_attention_signal" })
    ]);
  });

  test("does not treat chat mappings as Runner project context", () => {
    const decision = decidePiAttention({
      message: MESSAGE,
      policy: { projectMappings: [{ chatId: "oc_group", projectId: "demo" }] },
      projects: [{ id: "demo", name: "Demo" }]
    });

    expect(decision).toMatchObject({
      decision: "ask_clarification",
      needs_project: true,
      project_id: "",
      project_source: "none",
      reason: "needs_project",
      should_create_issue_proposal: false
    });
    expect(decision.evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "mention", reason: "bot_mentioned" }),
      expect.objectContaining({ kind: "keyword", value: "帮我" }),
      expect.objectContaining({ kind: "keyword", value: "实现" })
    ]));
  });

  test("treats slash issue commands as explicit task signals in trusted chats", () => {
    const decision = decidePiAttention({
      message: { ...MESSAGE, mentions: [], text: "/issue 在 codex-issue-runner 修复飞书上下文爆炸" },
      policy: {
        allowedChatIds: ["oc_group"],
        projectMappings: [{ chatId: "oc_group", projectId: "demo" }]
      },
      projects: [{ id: "demo", name: "Demo" }]
    });

    expect(decision).toMatchObject({
      decision: "ask_clarification",
      needs_project: true,
      project_id: "",
      reason: "needs_project",
      should_create_issue_proposal: false
    });
    expect(decision.signals).toEqual(expect.arrayContaining(["allowed_chat", "slash_issue_command"]));
  });

  test("routes trusted bug and feature text without requiring an explicit mention", () => {
    const decision = decidePiAttention({
      message: {
        ...MESSAGE,
        mentions: [],
        text: "线上 bug 报错了，日志见截图"
      },
      policy: {
        allowedChatIds: ["oc_group"],
        projectMappings: [{ chatId: "oc_group", projectId: "demo" }]
      },
      projects: [{ id: "demo", name: "Demo" }]
    });

    expect(decision).toMatchObject({
      decision: "ask_clarification",
      project_id: "",
      reason: "needs_project"
    });
    expect(decision.signals).toEqual(expect.arrayContaining([
      "allowed_chat",
      "bug_keyword",
      "log_keyword",
      "screenshot_keyword"
    ]));
  });

  test("trusted user mappings do not imply a Runner project", () => {
    const decision = decidePiAttention({
      message: { ...MESSAGE, chat_id: "oc_other", mentions: [], text: "帮我修复报错" },
      policy: {
        allowedUserIds: ["ou_open_1"],
        projectMappings: [{ projectId: "demo", userId: "ou_open_1" }]
      },
      projects: [{ id: "demo", name: "Demo" }]
    });

    expect(decision).toMatchObject({
      decision: "ask_clarification",
      project_id: "",
      project_source: "none",
      reason: "needs_project"
    });
    expect(decision.signals).toContain("allowed_user");
  });

  test("keeps trusted capability questions as conversational chat instead of requiring a project", () => {
    const decision = decidePiAttention({
      message: { ...MESSAGE, mentions: [], text: "你能帮我做什么" },
      policy: { allowedChatIds: ["oc_group"], allowedUserIds: ["ou_open_1"] },
      projects: [{ id: "demo", name: "Demo" }]
    });

    expect(decision).toMatchObject({
      decision: "inbox_only",
      needs_project: false,
      project_id: "",
      reason: "trusted_source_without_task_signal",
      should_create_issue_proposal: false
    });
    expect(decision.signals).toEqual(expect.arrayContaining(["allowed_chat", "allowed_user"]));
    expect(decision.signals).not.toContain("request_keyword");
  });

  test("asks clarification and marks needs_project when the project cannot be resolved", () => {
    const decision = decidePiAttention({
      message: { ...MESSAGE, text: "@PI 帮我修复这个 bug" },
      projects: [{ id: "other", name: "Other Repo" }]
    });

    expect(decision).toMatchObject({
      decision: "ask_clarification",
      needs_project: true,
      project_id: "",
      reason: "needs_project"
    });
    expect(decision.evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "mention" }),
      expect.objectContaining({ kind: "keyword", value: "修复" }),
      expect.objectContaining({ kind: "keyword", value: "bug" })
    ]));
  });

  test("resolves an explicit project name when chat mapping is absent", () => {
    const decision = decidePiAttention({
      message: { ...MESSAGE, text: "@PI 帮我修复 codex-runner 的报错" },
      projects: [{ id: "codex-runner", name: "Codex Issue Runner" }]
    });

    expect(decision).toMatchObject({
      decision: "propose_issue",
      project_id: "codex-runner",
      project_source: "explicit_project",
      reason: "task_signal_with_project"
    });
  });

  test("keeps trusted mapped chat without task signals as inbox only", () => {
    const decision = decidePiAttention({
      message: { ...MESSAGE, mentions: [], text: "收到，我稍后看。" },
      policy: {
        allowedChatIds: ["oc_group"],
        projectMappings: [{ chatId: "oc_group", projectId: "demo" }]
      },
      projects: [{ id: "demo", name: "Demo" }]
    });

    expect(decision).toMatchObject({
      decision: "inbox_only",
      needs_project: false,
      project_id: "",
      reason: "trusted_source_without_task_signal",
      should_create_issue_proposal: false
    });
  });

  test("blocks actionable text from untrusted unmentioned chats by policy", () => {
    const decision = decidePiAttention({
      message: { ...MESSAGE, mentions: [], text: "帮我实现新功能" },
      projects: [{ id: "demo", name: "Demo" }]
    });

    expect(decision).toMatchObject({
      decision: "blocked_by_policy",
      needs_project: false,
      reason: "task_signal_without_trusted_attention",
      should_create_issue_proposal: false
    });
  });
});
