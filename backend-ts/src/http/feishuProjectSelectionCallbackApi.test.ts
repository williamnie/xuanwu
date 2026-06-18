import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildConfig } from "../config/env.ts";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { getPiApprovalRequest, upsertPiApprovalRequest } from "../db/repositories/pi.ts";
import type { createFeishuAgentBridge } from "../integrations/feishuAgentBridge.ts";
import type { ExecutorProvider, ProviderRunInput } from "../providers/types.ts";
import { createDefaultRouter, createRequestHandler } from "./server.ts";

const BASE_URL = "http://127.0.0.1:3008";
const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) await rm(root, { recursive: true, force: true });
  }
});

describe("Feishu project selection callback endpoint", () => {
  test("passes project selection card callbacks to the Feishu agent bridge", async () => {
    const actions: unknown[] = [];
    const bridge = bridgeFixture(actions);
    const { database, handle } = await fixtureHandler(bridge);
    try {
      const response = await postFeishu(handle, projectSelectionCallback());

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        toast: {
          content: "已收到项目选择，正在继续处理。",
          type: "info"
        }
      });
      expect(actions).toEqual([{
        action_id: "event-card-1",
        chat_id: "oc_group",
        message_id: "om_card_1",
        project_id: "demo",
        selection_id: "fps_1",
        user_id: "ou_user_1",
        user_open_id: "ou_open_1"
      }]);
    } finally {
      database.close();
    }
  });

  test("resolves PI approval card callbacks through Codex provider once", async () => {
    const resolutions: Array<{ decision: string; id: string; scope: string }> = [];
    const { database, handle } = await fixtureHandler(bridgeFixture([]), approvalProvider(resolutions));
    try {
      upsertPiApprovalRequest(database, {
        approval_id: "approval-card-1",
        approval_source: "codex_provider_event",
        issue_id: 392,
        project_id: "demo",
        provider: "codex",
        provider_approval_id: "approval-card-1",
        request_summary: "command=git status",
        request_type: "command",
        status: "delivered",
        thread_id: "thread-approval",
        turn_id: "turn-approval"
      });

      const approveAction = approvalCallback("approval-card-1", "approve_session", "session");
      const first = await postFeishu(handle, approveAction);
      const replay = await postFeishu(handle, approveAction);
      const second = await postFeishu(handle, approvalCallback("approval-card-1", "deny", "turn"));

      expect(first.status).toBe(202);
      expect(await first.json()).toMatchObject({ ok: true, status: "approved" });
      expect(replay.status).toBe(202);
      expect(await replay.json()).toMatchObject({ ok: true, status: "approved" });
      expect(second.status).toBe(202);
      expect(await second.json()).toMatchObject({ ok: true, status: "approved" });
      expect(resolutions).toEqual([{ decision: "approve", id: "approval-card-1", scope: "turn" }]);
      expect(getPiApprovalRequest(database, "approval-card-1")).toMatchObject({
        resolved_decision: "approve",
        resolved_scope: "turn",
        status: "approved"
      });
    } finally {
      database.close();
    }
  });

  test("rejects approval card callbacks from unauthorized Feishu chats", async () => {
    const resolutions: Array<{ decision: string; id: string; scope: string }> = [];
    const { database, handle } = await fixtureHandler(
      bridgeFixture([]),
      approvalProvider(resolutions),
      { allowedChatIds: "oc_allowed" }
    );
    try {
      upsertPiApprovalRequest(database, {
        approval_id: "approval-card-denied-chat",
        approval_source: "codex_provider_event",
        issue_id: 392,
        project_id: "demo",
        provider: "codex",
        provider_approval_id: "approval-card-denied-chat",
        request_summary: "command=git status",
        request_type: "command",
        status: "delivered",
        thread_id: "thread-approval",
        turn_id: "turn-approval"
      });

      const response = await postFeishu(
        handle,
        approvalCallback("approval-card-denied-chat", "approve", "turn", { chatId: "oc_denied" })
      );

      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ message: "feishu approval callback is not allowed" });
      expect(resolutions).toEqual([]);
      expect(getPiApprovalRequest(database, "approval-card-denied-chat")).toMatchObject({
        resolved_decision: "",
        status: "delivered"
      });
    } finally {
      database.close();
    }
  });

  test("records rejected PI approval card callbacks", async () => {
    const resolutions: Array<{ decision: string; id: string; scope: string }> = [];
    const { database, handle } = await fixtureHandler(bridgeFixture([]), approvalProvider(resolutions));
    try {
      upsertPiApprovalRequest(database, {
        approval_id: "approval-card-reject",
        approval_source: "codex_provider_event",
        issue_id: 392,
        project_id: "demo",
        provider: "codex",
        provider_approval_id: "approval-card-reject",
        request_summary: "command=rm -rf tmp",
        request_type: "command",
        status: "delivered",
        thread_id: "thread-approval",
        turn_id: "turn-approval"
      });

      const response = await postFeishu(handle, approvalCallback("approval-card-reject", "deny", "turn"));

      expect(response.status).toBe(202);
      expect(await response.json()).toMatchObject({ ok: true, status: "rejected" });
      expect(resolutions).toEqual([{ decision: "deny", id: "approval-card-reject", scope: "turn" }]);
      expect(getPiApprovalRequest(database, "approval-card-reject")).toMatchObject({
        resolved_decision: "deny",
        resolved_scope: "turn",
        status: "rejected"
      });
    } finally {
      database.close();
    }
  });
});

async function fixtureHandler(
  agentBridge: ReturnType<typeof createFeishuAgentBridge>,
  provider?: ExecutorProvider,
  options: { allowedChatIds?: string; allowedUserIds?: string } = {}
) {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-feishu-card-callback-"));
  tempRoots.push(root);
  const database = await openDatabase({ stateDir: join(root, "state") });
  const config = buildConfig({
    feishuAppId: "cli_app_id",
    feishuAppSecret: "app-secret-value",
    feishuAllowedChatIds: options.allowedChatIds,
    feishuAllowedUserIds: options.allowedUserIds,
    feishuVerificationToken: "verify-token"
  });
  const router = createDefaultRouter({
    config,
    database,
    feishuAgentBridge: agentBridge,
    providers: provider ? { codex: provider } : undefined
  });
  return { database, handle: createRequestHandler(router, "") };
}

function approvalProvider(resolutions: Array<{ decision: string; id: string; scope: string }>): ExecutorProvider {
  return {
    capabilities: ["approvals"],
    id: "codex",
    async run(_input: ProviderRunInput): Promise<never> {
      throw new Error("not implemented");
    },
    async resolveApproval(id, decision) {
      resolutions.push({ id, decision: decision.decision, scope: decision.scope ?? "" });
    }
  };
}

function bridgeFixture(actions: unknown[]): ReturnType<typeof createFeishuAgentBridge> {
  return {
    handle: async () => ({ reason: "unused", replied: false }),
    handleProjectSelectionAction: async (action: unknown) => {
      actions.push(action);
      return { reason: "project_selection_continued", replied: true };
    }
  } as ReturnType<typeof createFeishuAgentBridge>;
}

async function postFeishu(handle: (request: Request) => Promise<Response>, body: unknown): Promise<Response> {
  return handle(new Request(`${BASE_URL}/api/integrations/feishu/events`, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "POST"
  }));
}

function projectSelectionCallback(): Record<string, unknown> {
  return {
    header: {
      event_id: "event-card-1",
      event_type: "card.action.trigger",
      token: "verify-token"
    },
    event: {
      action: {
        value: {
          action: "feishu_project_select",
          project_id: "demo",
          selection_id: "fps_1"
        }
      },
      context: {
        open_chat_id: "oc_group",
        open_message_id: "om_card_1"
      },
      operator: {
        operator_id: {
          open_id: "ou_open_1",
          user_id: "ou_user_1"
        }
      }
    },
    schema: "2.0"
  };
}

function approvalCallback(
  approvalID: string,
  decision: string,
  scope: string,
  options: { chatId?: string; userId?: string; userOpenId?: string } = {}
): Record<string, unknown> {
  return {
    header: {
      event_id: `event-${approvalID}-${decision}`,
      event_type: "card.action.trigger",
      token: "verify-token"
    },
    event: {
      action: {
        value: {
          action: "pi_approval_resolve",
          approval_id: approvalID,
          decision,
          scope
        }
      },
      context: {
        open_chat_id: options.chatId ?? "oc_group",
        open_message_id: `om_${approvalID}`
      },
      operator: {
        operator_id: {
          open_id: options.userOpenId ?? "ou_open_1",
          user_id: options.userId ?? "ou_user_1"
        }
      }
    },
    schema: "2.0"
  };
}
