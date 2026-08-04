import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildConfig } from "../config/env.ts";
import type { FeishuMessageSender } from "../pi/imReplyOutboxDispatcher.ts";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { createRequestHandler, createDefaultRouter } from "./server.ts";

const BASE_URL = "http://127.0.0.1:3008";
const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) await rm(root, { recursive: true, force: true });
  }
});

describe("IM reply drafts and sync outbox", () => {
  test("creates a pending Feishu reply draft after runner issue creation", async () => {
    const { database, handle, root } = await fixtureHandler("chat:oc_group=demo");
    await insertProject(database, root, "demo");
    try {
      const inbox = await postFeishu(handle, messageEvent({ threadId: "omt_thread_1" }));
      const inboxBody = await inbox.json() as Record<string, unknown>;
      const response = await createIssueFromExternalEvent(handle, Number(inboxBody.event_id), { project_id: "demo" });
      const body = await response.json() as Record<string, unknown>;
      const drafts = await getReplyDrafts(handle, "source=feishu");

      expect(response.status).toBe(201);
      expect(drafts).toHaveLength(1);
      expect(drafts[0]).toMatchObject({
        content: `已记录为 runner issue #${body.issue_id}，等待确认是否开始执行。`,
        created_by: "pi",
        issue_id: body.issue_id,
        risk: "low",
        source: "feishu",
        status: "pending",
        target_chat_id: "oc_group",
        target_message_id: "om_message_1",
        target_thread_id: "omt_thread_1"
      });
      const text = JSON.stringify(drafts[0]);
      expect(text).not.toContain("verify-token");
      expect(text).not.toContain(root);
      expect(text).not.toContain("at Object.");
    } finally {
      database.close();
    }
  });

  test("approves and rejects reply drafts through API state transitions", async () => {
    const { database, handle, root } = await fixtureHandler("chat:oc_group=demo");
    await insertProject(database, root, "demo");
    try {
      const firstDraft = await createDraftFromMessage(handle);
      const approved = await approveReplyDraft(handle, Number(firstDraft.id));
      const outbox = await getSyncOutbox(handle, "source=feishu");

      expect(approved.status).toBe(200);
      expect(await approved.json()).toMatchObject({
        draft: { id: firstDraft.id, status: "approved" },
        outbox: {
          content: firstDraft.content,
          issue_id: firstDraft.issue_id,
          reply_draft_id: firstDraft.id,
          source: "feishu",
          status: "pending"
        }
      });
      expect(outbox).toHaveLength(1);

      const secondDraft = await createDraftFromMessage(handle, {
        messageId: "om_message_2",
        text: "@PI another task"
      });
      const rejected = await rejectReplyDraft(handle, Number(secondDraft.id), { reason: "暂不发送" });

      expect(rejected.status).toBe(200);
      expect(await rejected.json()).toMatchObject({
        id: secondDraft.id,
        rejection_reason: "暂不发送",
        status: "rejected"
      });
      expect(await getSyncOutbox(handle, "source=feishu")).toHaveLength(1);
    } finally {
      database.close();
    }
  });

  test("dispatches approved Feishu outbox through API with injected client", async () => {
    const sender = new FakeFeishuSender();
    const { database, handle, root } = await fixtureHandler("chat:oc_group=demo", sender);
    await insertProject(database, root, "demo");
    try {
      const draft = await createDraftFromMessage(handle);
      await approveReplyDraft(handle, Number(draft.id));

      const response = await handle(new Request(`${BASE_URL}/api/sync-outbox/dispatch`, {
        body: JSON.stringify({ limit: 5 }),
        headers: { "content-type": "application/json" },
        method: "POST"
      }));
      const outbox = await getSyncOutbox(handle, "source=feishu");

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ processed: 1, sent: 1 });
      expect(sender.calls).toEqual([{ receiveId: "oc_group", receiveIdType: "chat_id", text: String(draft.content) }]);
      expect(outbox[0]).toMatchObject({ feishu_message_id: "om_api_sent_1", status: "sent" });
    } finally {
      database.close();
    }
  });
});

class FakeFeishuSender implements FeishuMessageSender {
  calls: Array<{ receiveId: string; receiveIdType: string; text: string }> = [];

  async sendTextMessage(input: { receiveId: string; receiveIdType: string; text: string }): Promise<{ messageId: string }> {
    this.calls.push(input);
    return { messageId: "om_api_sent_1" };
  }
}

async function createDraftFromMessage(
  handle: (request: Request) => Promise<Response>,
  input: { messageId?: string; text?: string } = {}
): Promise<Record<string, unknown>> {
  const inbox = await postFeishu(handle, messageEvent(input));
  const inboxBody = await inbox.json() as Record<string, unknown>;
  await createIssueFromExternalEvent(handle, Number(inboxBody.event_id), { project_id: "demo" });
  const drafts = await getReplyDrafts(handle, "status=pending");
  return drafts.find((item) => item.target_message_id === (input.messageId ?? "om_message_1")) ?? {};
}

async function fixtureHandler(projectMappings = "", feishuSender?: FeishuMessageSender): Promise<{
  database: RunnerDatabase;
  handle: (request: Request) => Promise<Response>;
  root: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "xuanwu-im-outbox-"));
  tempRoots.push(root);
  const database = await openDatabase({ stateDir: join(root, "state") });
  const config = buildConfig({
    feishuAppId: "cli_app_id",
    feishuAppSecret: "app-secret-value",
    feishuProjectMappings: projectMappings,
    feishuVerificationToken: "verify-token"
  });
  const router = createDefaultRouter({ config, database, feishuSender });
  return { database, handle: createRequestHandler(router, config.authToken), root };
}

async function getReplyDrafts(handle: (request: Request) => Promise<Response>, query = ""): Promise<Array<Record<string, unknown>>> {
  const response = await handle(new Request(`${BASE_URL}/api/im-reply-drafts${query === "" ? "" : `?${query}`}`));
  expect(response.status).toBe(200);
  return await response.json() as Array<Record<string, unknown>>;
}

async function getSyncOutbox(handle: (request: Request) => Promise<Response>, query = ""): Promise<Array<Record<string, unknown>>> {
  const response = await handle(new Request(`${BASE_URL}/api/sync-outbox${query === "" ? "" : `?${query}`}`));
  expect(response.status).toBe(200);
  return await response.json() as Array<Record<string, unknown>>;
}

async function postFeishu(handle: (request: Request) => Promise<Response>, body: unknown): Promise<Response> {
  return handle(new Request(`${BASE_URL}/api/integrations/feishu/events`, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "POST"
  }));
}

async function createIssueFromExternalEvent(
  handle: (request: Request) => Promise<Response>,
  id: number,
  body: Record<string, unknown> = {}
): Promise<Response> {
  return handle(new Request(`${BASE_URL}/api/external-events/${id}/create-issue`, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "POST"
  }));
}

async function approveReplyDraft(handle: (request: Request) => Promise<Response>, id: number): Promise<Response> {
  return handle(new Request(`${BASE_URL}/api/im-reply-drafts/${id}/approve`, { method: "POST" }));
}

async function rejectReplyDraft(
  handle: (request: Request) => Promise<Response>,
  id: number,
  body: Record<string, unknown>
): Promise<Response> {
  return handle(new Request(`${BASE_URL}/api/im-reply-drafts/${id}/reject`, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "POST"
  }));
}

async function insertProject(database: RunnerDatabase, root: string, id: string): Promise<void> {
  const cwd = join(root, id);
  await mkdir(cwd, { recursive: true });
  database.sqlite.run("insert into projects (id, name, cwd, created_at, updated_at) values (?, ?, ?, ?, ?)", [
    id, id, cwd, "2026-06-12T08:00:00Z", "2026-06-12T08:00:00Z"
  ]);
}

function messageEvent(input: {
  messageId?: string;
  text?: string;
  threadId?: string;
} = {}): Record<string, unknown> {
  return {
    header: { event_id: `event-${input.messageId ?? "om_message_1"}`, event_type: "im.message.receive_v1", token: "verify-token" },
    event: {
      message: {
        chat_id: "oc_group",
        chat_type: "group",
        content: JSON.stringify({ text: input.text ?? "@PI implement it" }),
        create_time: "1781244167890",
        mentions: [{ id: "ou_bot", name: "PI", tenant_key: "tenant_a" }],
        message_id: input.messageId ?? "om_message_1",
        parent_id: input.threadId ?? ""
      },
      sender: {
        sender_id: { open_id: "ou_open_1", user_id: "ou_user_1" },
        sender_type: "user",
        tenant_key: "tenant_a"
      }
    },
    schema: "2.0"
  };
}
