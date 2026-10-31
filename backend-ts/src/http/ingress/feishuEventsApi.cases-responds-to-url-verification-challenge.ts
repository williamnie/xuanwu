import { expect, test } from "bun:test";
import { listContextBundles } from "../../db/repositories/contextBundles.ts";
import { listAttentionInboxItems } from "../../db/repositories/intakeRuns.ts";
import { listActionProposals } from "../../db/repositories/pi.ts";
import type { createFeishuAgentBridge } from "../../integrations/feishu/feishuAgentBridge.ts";
import type { TestFixture } from "./feishuEventsApi.testFixture.ts";

export function registerRespondsToUrlVerificationChallengeCases(testScope: TestFixture) {
  const { ENCRYPT_KEY, fixtureHandler, postFeishu, signedHeaders, messageEvent, seedProject, feishuTaskIntakeModel, feishuIgnoredIntakeModel, encryptedChallengePayload, encryptedMessagePayload } = testScope;
  test("responds to URL verification challenge without requiring runner bearer auth", async () => {
      const { bus, database, handle } = await fixtureHandler({ runnerAuthToken: "runner-secret" });
      const subscription = bus.subscribe();
      try {
        const response = await postFeishu(handle, { challenge: "challenge-code", token: "verify-token", type: "url_verification" });
        const received = await subscription.next();
        const challenge = await subscription.next();
  
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ challenge: "challenge-code" });
        expect(received).toMatchObject({ type: "integration.feishu.audit" });
        expect(JSON.parse(String(challenge?.payload))).toMatchObject({
          connector: "feishu",
          outcome: "challenge",
          reason: "challenge_verified"
        });
      } finally {
        subscription.close();
        database.close();
      }
    });
  
  test("normalizes valid message events and publishes redacted audit summary", async () => {
      const { bus, database, handle } = await fixtureHandler({
        encryptKey: ENCRYPT_KEY,
        projectMappings: "chat:oc_group=demo"
      });
      const subscription = bus.subscribe();
      const body = messageEvent({ token: "verify-token" });
      const rawBody = JSON.stringify(body);
      try {
        const response = await postFeishu(handle, body, signedHeaders(rawBody));
        const received = await subscription.next();
        const accepted = await subscription.next();
        const payload = JSON.parse(String(accepted?.payload));
        const text = JSON.stringify({ received, accepted, body: await response.json() });
  
        expect(response.status).toBe(202);
        expect(payload).toMatchObject({
          connector: "feishu",
          dedupe_key: "feishu:message:om_message_1",
          normalized_summary: {
            attachment_count: 0,
            chat_id: "oc_group",
            message_id: "om_message_1",
            project_id: "",
            sender_type: "user",
            text_length: 16
          },
          outcome: "accepted",
          reason: "message_normalized"
        });
        expect(text).not.toContain("verify-token");
        expect(text).not.toContain(ENCRYPT_KEY);
      } finally {
        subscription.close();
        database.close();
      }
    });
  
  test("passes accepted callback messages to the Feishu agent bridge", async () => {
      const bridgeCalls: Array<{ messageId: string; projectId: unknown; text: string }> = [];
      const bridge: ReturnType<typeof createFeishuAgentBridge> = {
        handle: async ({ event, ingest }) => {
          bridgeCalls.push({
            messageId: event.message_id,
            projectId: ingest.normalized_summary.project_id,
            text: event.text
          });
          return { reason: "agent_reply_sent", replied: true };
        },
        resolveProjectSelectionAction: async () => ({ reason: "unused", replied: false })
      };
      const { database, handle } = await fixtureHandler({
        agentBridge: bridge,
        projectMappings: "chat:oc_group=demo"
      });
      const response = await postFeishu(handle, messageEvent({ token: "verify-token" }));
  
      expect(response.status).toBe(202);
      expect(bridgeCalls).toEqual([{
        messageId: "om_message_1",
        projectId: "",
        text: "@PI implement it"
      }]);
    });
  
  test("routes accepted Feishu messages through generic intake and keeps legacy bridge fallback", async () => {
      const bridgeCalls: string[] = [];
      const bridge: ReturnType<typeof createFeishuAgentBridge> = {
        handle: async ({ event }) => {
          bridgeCalls.push(event.message_id);
          return { reason: "agent_reply_sent", replied: true };
        },
        resolveProjectSelectionAction: async () => ({ reason: "unused", replied: false })
      };
      const { database, handle } = await fixtureHandler({
        agentBridge: bridge,
        feishuIntakeModel: feishuTaskIntakeModel(),
        feishuIntakePolicy: { action_mode: "propose_actions", profile: "company_chat" }
      });
      seedProject(database, "demo");
      const response = await postFeishu(handle, messageEvent({
        text: "@PI demo 登录页 500 了，请创建 issue",
        token: "verify-token"
      }));
      const body = await response.json() as Record<string, unknown>;
      const bundles = listContextBundles(database, "feishu");
      const items = listAttentionInboxItems(database, { source: "feishu" });
      const proposals = listActionProposals(database);
  
      expect(response.status).toBe(202);
      expect(body).toMatchObject({ ok: true });
      expect(bundles).toHaveLength(1);
      expect(bundles[0]).toMatchObject({ source: "feishu", trigger: "mention" });
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        primary_intent: "bug_report",
        source: "feishu",
        status: "proposal_created",
        title: "登录页 500"
      });
      expect(proposals).toHaveLength(1);
      expect(proposals[0].actions).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "issue.create" })
      ]));
      expect(bridgeCalls).toEqual(["om_message_1"]);
    });
  
  test("does not create proposals when generic intake classifies Feishu chat as non-task", async () => {
      const { database, handle } = await fixtureHandler({
        feishuIntakeModel: feishuIgnoredIntakeModel(),
        feishuIntakePolicy: { action_mode: "propose_actions", profile: "company_chat" }
      });
      const response = await postFeishu(handle, messageEvent({ text: "@PI 你是谁？", token: "verify-token" }));
  
      expect(response.status).toBe(202);
      expect(listContextBundles(database, "feishu")).toHaveLength(1);
      expect(listAttentionInboxItems(database, { source: "feishu" })).toHaveLength(0);
      expect(listActionProposals(database)).toHaveLength(0);
    });
  
  test("responds to encrypted URL verification when encrypt key is configured", async () => {
      const { bus, database, handle } = await fixtureHandler({ encryptKey: ENCRYPT_KEY });
      const subscription = bus.subscribe();
      const encrypted = encryptedChallengePayload();
      try {
        const response = await postFeishu(handle, { encrypt: encrypted });
        await subscription.next();
        const challenge = await subscription.next();
  
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ challenge: "encrypted-challenge" });
        expect(JSON.parse(String(challenge?.payload))).toMatchObject({
          encrypted: true,
          outcome: "challenge",
          reason: "challenge_verified"
        });
      } finally {
        subscription.close();
        database.close();
      }
    });
  
  test("returns diagnostic error for encrypted callbacks without encrypt key", async () => {
      const { bus, database, handle } = await fixtureHandler({});
      const subscription = bus.subscribe();
      try {
        const response = await postFeishu(handle, { encrypt: encryptedMessagePayload() });
        await subscription.next();
        const rejected = await subscription.next();
  
        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({ message: "feishu encrypted callback requires FEISHU_ENCRYPT_KEY" });
        expect(JSON.parse(String(rejected?.payload))).toMatchObject({
          outcome: "rejected",
          reason: "encrypted_event_without_encrypt_key"
        });
      } finally {
        subscription.close();
        database.close();
      }
    });
  
  test("rejects invalid verification token and records a safe refusal reason", async () => {
      const { bus, database, handle } = await fixtureHandler({});
      const subscription = bus.subscribe();
      try {
        const response = await postFeishu(handle, messageEvent({ token: "wrong-token" }));
        await subscription.next();
        const rejected = await subscription.next();
        const text = JSON.stringify({ audit: rejected, body: await response.json() });
  
        expect(response.status).toBe(401);
        expect(JSON.parse(String(rejected?.payload))).toMatchObject({
          connector: "feishu",
          outcome: "rejected",
          reason: "invalid_verification_token"
        });
        expect(text).not.toContain("verify-token");
        expect(text).not.toContain("wrong-token");
      } finally {
        subscription.close();
        database.close();
      }
    });
}
