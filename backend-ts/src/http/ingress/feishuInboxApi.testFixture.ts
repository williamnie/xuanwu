import { afterEach, expect } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildConfig } from "../../config/env.ts";
import { openDatabase, type RunnerDatabase } from "../../db/database.ts";
import { createRequestHandler, createDefaultRouter } from "../server.ts";
import { useDatabaseCleanup } from "../../testing/harness.ts";



export function createTestFixture() {
  const trackDatabase = useDatabaseCleanup();

  const BASE_URL = "http://127.0.0.1:3008";

  const tempRoots: string[] = [];

  afterEach(async () => {
    while (tempRoots.length > 0) {
      const root = tempRoots.pop();
      if (root) await rm(root, { recursive: true, force: true });
    }
  });

  async function fixtureHandler(projectMappings = ""): Promise<{
    database: RunnerDatabase;
    handle: (request: Request) => Promise<Response>;
    root: string;
  }> {
    const root = await mkdtemp(join(tmpdir(), "xuanwu-feishu-inbox-"));
    tempRoots.push(root);
    const database = await openDatabase({ stateDir: join(root, "state") }).then(trackDatabase);
    const config = buildConfig({
      feishuAppId: "cli_app_id",
      feishuAppSecret: "app-secret-value",
      feishuProjectMappings: projectMappings,
      feishuVerificationToken: "verify-token"
    });
    const router = createDefaultRouter({ config, database });
    return { database, handle: createRequestHandler(router, config.authToken), root };
  }

  async function getExternalEvents(handle: (request: Request) => Promise<Response>, query = ""): Promise<Array<Record<string, unknown>>> {
    const path = `/api/external-events${query === "" ? "" : `?${query}`}`;
    const response = await handle(new Request(`${BASE_URL}${path}`));
    expect(response.status).toBe(200);
    return await response.json() as Array<Record<string, unknown>>;
  }

  async function getExternalEvent(handle: (request: Request) => Promise<Response>, id: number): Promise<Record<string, unknown>> {
    const response = await handle(new Request(`${BASE_URL}/api/external-events/${id}`));
    expect(response.status).toBe(200);
    return await response.json() as Record<string, unknown>;
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

  async function approveReplyDraft(handle: (request: Request) => Promise<Response>, id: number): Promise<Response> {
    return handle(new Request(`${BASE_URL}/api/im-reply-drafts/${id}/approve`, { method: "POST" }));
  }

  async function getIssue(handle: (request: Request) => Promise<Response>, id: number): Promise<Record<string, unknown>> {
    const response = await handle(new Request(`${BASE_URL}/api/issues/${id}`));
    expect(response.status).toBe(200);
    return await response.json() as Record<string, unknown>;
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

  async function insertProject(database: RunnerDatabase, root: string, id: string): Promise<void> {
    const cwd = join(root, id);
    await mkdir(cwd, { recursive: true });
    database.sqlite.run("insert into projects (id, name, cwd, created_at, updated_at) values (?, ?, ?, ?, ?)", [
      id,
      id,
      cwd,
      "2026-06-12T08:00:00Z",
      "2026-06-12T08:00:00Z"
    ]);
  }

  function messageEvent(input: {
    attachments?: Array<Record<string, unknown>>;
    mentions?: Array<Record<string, unknown>>;
    text?: string;
    threadId?: string;
  } = {}): Record<string, unknown> {
    return {
      header: { event_id: "event-v2-1", event_type: "im.message.receive_v1", token: "verify-token" },
      event: {
        message: {
          attachments: input.attachments ?? [],
          chat_id: "oc_group",
          chat_type: "group",
          content: JSON.stringify({ text: input.text ?? "@PI implement it" }),
          create_time: "1781244167890",
          mentions: input.mentions ?? [{ id: "ou_bot", name: "PI", tenant_key: "tenant_a" }],
          message_id: "om_message_1",
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
  return { trackDatabase, BASE_URL, tempRoots, fixtureHandler, getExternalEvents, getExternalEvent, getReplyDrafts, getSyncOutbox, approveReplyDraft, getIssue, postFeishu, createIssueFromExternalEvent, insertProject, messageEvent };
}
export type TestFixture = ReturnType<typeof createTestFixture>;
