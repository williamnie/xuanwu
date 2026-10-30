import { afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildConfig } from "../../config/env.ts";
import { openDatabase, type RunnerDatabase } from "../../db/database.ts";
import { createExternalEvent } from "../../db/repositories/externalEvents.ts";
import { createExternalLink } from "../../db/repositories/externalLinks.ts";
import { createIssue } from "../../db/repositories/issueCreate.ts";
import { createPiAction } from "../../db/repositories/pi.ts";
import { createDefaultRouter, createRequestHandler } from "../../http/server.ts";
import { type FeishuMessageSender } from "./feishuOutboxDispatcherCompat.ts";
import { useDatabaseCleanup } from "../../testing/harness.ts";



export function createTestFixture() {
  const trackDatabase = useDatabaseCleanup();

  const tempRoots: string[] = [];

  const BASE_URL = "http://127.0.0.1:3008";

  afterEach(async () => {
    while (tempRoots.length > 0) await rm(tempRoots.pop() ?? "", { recursive: true, force: true });
  });

  async function fixtureHandler(options: { allowedChatIds?: string; allowedUserIds?: string } = {}) {
    const database = await fixtureDatabase();
    const config = buildConfig({
      feishuAllowedChatIds: options.allowedChatIds,
      feishuAllowedUserIds: options.allowedUserIds,
      feishuAppId: "cli_app_id",
      feishuAppSecret: "app-secret-value",
      feishuVerificationToken: "verify-token"
    });
    const router = createDefaultRouter({ config, database });
    return { database, handle: createRequestHandler(router, "") };
  }

  async function fixtureDatabase(): Promise<RunnerDatabase> {
    const root = await mkdtemp(join(tmpdir(), "xuanwu-feishu-pi-action-card-"));
    tempRoots.push(root);
    const db = await openDatabase({ stateDir: join(root, "state") }).then(trackDatabase);
    db.sqlite.run(
      `insert into projects (id, name, cwd, provider, provider_config_json, sort_order, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?)`,
      ["demo", "Demo", join(root, "project"), "codex", '{"capabilities":["issue_execution"]}', 1,
        "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
    );
    return db;
  }

  function linkedFeishuIssue(db: RunnerDatabase): number {
    const issue = createIssue(db, { project_id: "demo", title: "Feishu task", status: "triage" });
    const event = createExternalEvent(db, {
      content: "帮我修复问题",
      dedupe_key: "feishu:message:om_task",
      external_id: "om_task",
      normalized_message: {
        chat_id: "oc_group",
        message_id: "om_task",
        sender: { id: "ou_user_1", open_id: "ou_open_1" }
      },
      source: "feishu"
    });
    createExternalLink(db, {
      conversation_id: "oc_group",
      external_event_id: event.id,
      external_type: "feishu_message",
      issue_id: issue.id,
      project_id: "demo",
      relationship: "created_issue",
      source: "feishu"
    });
    return issue.id;
  }

  function createPendingPiAction(db: RunnerDatabase, id: string, issueID: number, body?: string): void {
    createPiAction(db, {
      action_type: "issue.comment",
      gate_decision: "ask",
      id,
      issue_id: issueID,
      payload_json: JSON.stringify({ body: body ?? `body for ${id}`, issue_id: issueID }),
      project_id: "demo",
      requires_confirmation: 1,
      risk_level: "medium",
      status: "pending"
    });
  }

  async function postFeishu(handle: (request: Request) => Promise<Response>, body: unknown): Promise<Response> {
    return handle(new Request(`${BASE_URL}/api/integrations/feishu/events`, {
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
      method: "POST"
    }));
  }

  function piActionCallback(
    actionID: string,
    decision: string,
    options: { chatId?: string; snoozeMinutes?: number; userId?: string; userOpenId?: string } = {}
  ): Record<string, unknown> {
    return {
      header: { event_id: `event-${actionID}-${decision}`, event_type: "card.action.trigger", token: "verify-token" },
      event: {
        action: { value: { action: "pi_action_resolve", action_id: actionID, comment: "Needs changes from Feishu", decision, snooze_minutes: options.snoozeMinutes } },
        context: { open_chat_id: options.chatId ?? "oc_group", open_message_id: `om_${actionID}` },
        operator: { operator_id: { open_id: options.userOpenId ?? "ou_open_1", user_id: options.userId ?? "ou_user_1" } }
      },
      schema: "2.0"
    };
  }

  function imInteractionCallback(interactionID: string, actionID: string): Record<string, unknown> {
    return {
      header: { event_id: `event-${interactionID}`, event_type: "card.action.trigger", token: "verify-token" },
      event: {
        action: { value: { action: "xuanwu_im_interaction", action_id: actionID, interaction_id: interactionID, revision: 1 } },
        context: { open_chat_id: "oc_group", open_message_id: "om_generic" },
        operator: { operator_id: { open_id: "ou_open_1", user_id: "ou_user_1" } }
      },
      schema: "2.0"
    };
  }

  class FakeFeishuSender implements FeishuMessageSender {
    calls: Array<{ receiveId: string; receiveIdType: string; text: string }> = [];
    cardCalls: Array<{ card: Record<string, unknown>; receiveId: string; receiveIdType: string }> = [];
  
    async sendInteractiveCard(input: {
      card: Record<string, unknown>;
      receiveId: string;
      receiveIdType: string;
    }): Promise<{ messageId: string }> {
      this.cardCalls.push(input);
      return { messageId: `om_card_${this.cardCalls.length}` };
    }
  
    async sendTextMessage(input: { receiveId: string; receiveIdType: string; text: string }): Promise<{ messageId: string }> {
      this.calls.push(input);
      return { messageId: `om_text_${this.calls.length}` };
    }
  }
  return { trackDatabase, tempRoots, BASE_URL, fixtureHandler, fixtureDatabase, linkedFeishuIssue, createPendingPiAction, postFeishu, piActionCallback, imInteractionCallback, FakeFeishuSender };
}
export type TestFixture = ReturnType<typeof createTestFixture>;
