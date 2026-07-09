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

  test("issue policy keeps create/enqueue confirm-first unless explicitly enabled", () => {
    expect(decideSourcePermission({
      actionRisk: "medium",
      actionType: "issue.create",
      payload: { status: "triage" },
      sourcePolicy: { issue_policy: { auto_create_triage_issue: false } }
    })).toMatchObject({ reason: "auto_create_triage_issue_disabled", requiresApproval: true });

    expect(decideSourcePermission({
      actionRisk: "medium",
      actionType: "issue.create",
      payload: { status: "triage" },
      sourcePolicy: { issue_policy: { auto_create_triage_issue: true } }
    })).toMatchObject({ canAutoExecute: true, reason: "triage_issue_auto_create_allowed" });

    expect(decideSourcePermission({
      actionRisk: "medium",
      actionType: "issue.enqueue",
      payload: { issue_id: 42 },
      sourcePolicy: { issue_policy: { auto_enqueue: true } }
    })).toMatchObject({ canAutoExecute: true, reason: "issue_enqueue_allowed" });

    expect(decideSourcePermission({
      actionRisk: "high",
      actionType: "issue.enqueue",
      payload: { issue_id: 42 },
      sourcePolicy: { issue_policy: { auto_enqueue: true } }
    })).toMatchObject({ reason: "issue_enqueue_risk_requires_approval", requiresApproval: true });
  });

  test("require_project_confirmation blocks issue creation without confirmed project", () => {
    expect(decideSourcePermission({
      actionRisk: "medium",
      actionType: "issue.create",
      payload: { status: "triage" },
      sourcePolicy: { issue_policy: { auto_create_triage_issue: true, require_project_confirmation: true } }
    })).toMatchObject({ reason: "project_confirmation_required", requiresApproval: true });

    expect(decideSourcePermission({
      actionRisk: "medium",
      actionType: "issue.create",
      payload: { project_confirmed: true, status: "triage" },
      sourcePolicy: { issue_policy: { auto_create_triage_issue: true, require_project_confirmation: true } }
    })).toMatchObject({ canAutoExecute: true, reason: "triage_issue_auto_create_allowed" });
  });
});
