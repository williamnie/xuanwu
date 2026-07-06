import { describe, expect, test } from "bun:test";
import { decideSourcePermission } from "./sourcePermissionPolicy.ts";

describe("PI source permission policy", () => {
  test("message.reply_send requires approval when auto reply is disabled", () => {
    const decision = decideSourcePermission({
      actionRisk: "low",
      actionType: "message.reply_send",
      actor: "alice",
      chat: "chat-a",
      source: "fixture-im"
    });

    expect(decision).toMatchObject({
      canAutoExecute: false,
      reason: "auto_reply_disabled",
      requiresApproval: true
    });
  });

  test("low-risk reply_send can auto execute only for enabled allowlisted targets", () => {
    expect(decideSourcePermission({
      actionRisk: "low",
      actionType: "message.reply_send",
      actor: "alice",
      chat: "chat-a",
      replyPolicy: { allowed_chats: ["chat-a"], auto_reply_enabled: true },
      source: "fixture-im"
    })).toMatchObject({ canAutoExecute: true, reason: "low_risk_auto_reply_allowed" });

    expect(decideSourcePermission({
      actionRisk: "low",
      actionType: "message.reply_send",
      actor: "alice",
      chat: "chat-b",
      replyPolicy: { allowed_chats: ["chat-a"], auto_reply_enabled: true },
      source: "fixture-im"
    })).toMatchObject({ reason: "chat_not_allowed", requiresApproval: true });

    expect(decideSourcePermission({
      actionRisk: "high",
      actionType: "message.reply_send",
      actor: "alice",
      chat: "chat-a",
      replyPolicy: { allowed_chats: ["chat-a"], auto_reply_enabled: true },
      source: "fixture-im"
    })).toMatchObject({ reason: "external_reply_risk_requires_approval", requiresApproval: true });

    expect(decideSourcePermission({
      actionRisk: "low",
      actionType: "message.reply_send",
      actor: "bob",
      person: "alice",
      replyPolicy: { allowed_people: ["alice"], auto_reply_enabled: true },
      source: "fixture-dm"
    })).toMatchObject({ canAutoExecute: true, reason: "low_risk_auto_reply_allowed" });
  });

  test("explicit external approval flag and missing allowlist block auto reply", () => {
    expect(decideSourcePermission({
      actionRisk: "low",
      actionType: "message.reply_send",
      actor: "alice",
      chat: "chat-a",
      replyPolicy: { auto_reply_enabled: true, require_approval_for_external_reply: true },
      source: "fixture-im"
    })).toMatchObject({ reason: "external_reply_requires_approval", requiresApproval: true });

    expect(decideSourcePermission({
      actionRisk: "low",
      actionType: "message.reply_send",
      actor: "alice",
      chat: "chat-a",
      replyPolicy: { auto_reply_enabled: true },
      source: "fixture-im"
    })).toMatchObject({ reason: "auto_reply_target_not_allowlisted", requiresApproval: true });
  });
});
