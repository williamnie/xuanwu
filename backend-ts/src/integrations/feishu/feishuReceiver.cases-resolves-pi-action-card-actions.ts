import { expect, test } from "bun:test";
import { buildFeishuConnectorConfig } from "./feishu.ts";
import { createFeishuReceiverManager } from "./feishuReceiver.ts";
import { createIssue } from "../../db/repositories/issueCreate.ts";
import { listIssueEvents } from "../../db/repositories/issueEvents.ts";
import { createImInteractionBinding } from "../../db/repositories/imInteractionBindings.ts";
import { createPiAction, getPiAction } from "../../db/repositories/pi.ts";
import type { TestFixture } from "./feishuReceiver.testFixture.ts";

export function registerResolvesPiActionCardActionsCases(testScope: TestFixture) {
  const { receiverFixture, piActionCardEvent, opaqueInteractionEvent, insertProject } = testScope;
  test("resolves PI action card actions from long connection callbacks", async () => {
      const { database, factory, messages } = await receiverFixture();
      insertProject(database);
      const issue = createIssue(database, { project_id: "demo", status: "triage", title: "PI action target" });
      createPiAction(database, {
        action_type: "issue.comment",
        gate_decision: "ask",
        id: "pi-action-ws-1",
        issue_id: issue.id,
        payload_json: JSON.stringify({ body: "Approved from websocket", issue_id: issue.id }),
        project_id: "demo",
        requires_confirmation: 1,
        risk_level: "medium",
        status: "pending"
      });
      const manager = createFeishuReceiverManager({ database, wsFactory: factory });
      const config = buildFeishuConnectorConfig({
        FEISHU_ALLOWED_CHAT_IDS: "oc_group",
        FEISHU_ALLOWED_USER_IDS: "ou_user_1",
        FEISHU_APP_ID: "cli_app_id",
        FEISHU_APP_SECRET: "app-secret-value"
      });
  
      await manager.restart(config);
      const response = await messages.emit(piActionCardEvent("pi-action-ws-1", "approve"));
  
      expect(response).toMatchObject({ ok: true, status: "completed" });
      expect(getPiAction(database, "pi-action-ws-1")).toMatchObject({
        approved_by: "feishu:ou_user_1",
        status: "completed"
      });
      expect(listIssueEvents(database, issue.id).map((event) => event.type)).toContain("issue.comment");
      database.close();
    });
  
  test("resolves flattened opaque PI action callbacks from the long-connection SDK", async () => {
      const { database, factory, messages } = await receiverFixture();
      insertProject(database);
      const issue = createIssue(database, { project_id: "demo", status: "triage", title: "Opaque PI action target" });
      createPiAction(database, {
        action_type: "issue.comment",
        gate_decision: "ask",
        id: "pi-action-ws-opaque",
        issue_id: issue.id,
        payload_json: JSON.stringify({ body: "Approved from flattened callback", issue_id: issue.id }),
        project_id: "demo",
        requires_confirmation: 1,
        risk_level: "medium",
        status: "pending"
      });
      const binding = createImInteractionBinding(database, {
        actionKind: "pi_action",
        actionRef: "pi_actions:pi-action-ws-opaque",
        actions: [{ action_id: "approve", value: "approve" }],
        actor: { id: "ou_user_1", openId: "ou_open_1" },
        connectorId: "feishu",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        scopeKey: "oc_group"
      });
      const manager = createFeishuReceiverManager({ database, wsFactory: factory });
      const config = buildFeishuConnectorConfig({
        FEISHU_ALLOWED_CHAT_IDS: "oc_group",
        FEISHU_ALLOWED_USER_IDS: "ou_user_1",
        FEISHU_APP_ID: "cli_app_id",
        FEISHU_APP_SECRET: "app-secret-value"
      });
  
      await manager.restart(config);
      const response = await messages.emit(opaqueInteractionEvent(binding.interaction_id, "approve"));
  
      expect(response).toMatchObject({
        reason: "consumed",
        resolution: { ok: true, status: "completed" }
      });
      expect(getPiAction(database, "pi-action-ws-opaque")).toMatchObject({
        approved_by: "feishu:ou_user_1",
        status: "completed"
      });
      expect(listIssueEvents(database, issue.id).map((event) => event.type)).toContain("issue.comment");
      database.close();
    });
}
