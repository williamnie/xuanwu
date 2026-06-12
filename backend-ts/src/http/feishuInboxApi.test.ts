import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildConfig } from "../config/env.ts";
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

describe("Feishu external event inbox", () => {
  test("persists normalized message events into the external event inbox", async () => {
    const { database, handle } = await fixtureHandler("chat:oc_group=demo");
    try {
      const response = await postFeishu(handle, messageEvent());
      const accepted = await response.json() as Record<string, unknown>;
      const events = await getExternalEvents(handle, "source=feishu");
      const detail = await getExternalEvent(handle, Number(accepted.event_id));

      expect(response.status).toBe(202);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        actor: "feishu:user:ou_user_1",
        dedupe_key: "feishu:message:om_message_1",
        external_id: "om_message_1",
        normalized_message: { text: "@PI implement it" },
        project_id: "demo",
        source: "feishu",
        status: "mapped"
      });
      expect(events[0].raw_payload_ref).toMatch(/^sha256:/);
      expect(events[0].summary).toMatchObject({
        attention_decision: {
          decision: "propose_issue",
          project_id: "demo",
          reason: "task_signal_with_project"
        },
        chat_id: "oc_group",
        message_id: "om_message_1",
        project_id: "demo",
        text_length: 16
      });
      expect(detail).toEqual(events[0]);
    } finally {
      database.close();
    }
  });

  test("keeps unmatched Feishu messages as unassigned inbox events", async () => {
    const { database, handle } = await fixtureHandler();
    try {
      const response = await postFeishu(handle, messageEvent());
      const events = await getExternalEvents(handle, "source=feishu");

      expect(response.status).toBe(202);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        project_id: "",
        status: "needs_project",
        summary: {
          attention_decision: {
            decision: "ask_clarification",
            needs_project: true,
            reason: "needs_project"
          }
        }
      });
    } finally {
      database.close();
    }
  });

  test("does not create proposal decisions for ordinary chat noise", async () => {
    const { database, handle } = await fixtureHandler("chat:oc_group=demo");
    try {
      const response = await postFeishu(handle, messageEvent({ text: "今晚吃啥？", mentions: [] }));
      const events = await getExternalEvents(handle, "source=feishu");

      expect(response.status).toBe(202);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        project_id: "demo",
        status: "ignored",
        summary: {
          attention_decision: {
            decision: "ignore",
            reason: "no_attention_signal",
            should_create_issue_proposal: false
          }
        }
      });
    } finally {
      database.close();
    }
  });

  test("replayed Feishu message_id does not create duplicate inbox records", async () => {
    const { database, handle } = await fixtureHandler();
    try {
      const first = await postFeishu(handle, messageEvent());
      const replay = await postFeishu(handle, messageEvent());
      const firstBody = await first.json() as Record<string, unknown>;
      const replayBody = await replay.json() as Record<string, unknown>;
      const events = await getExternalEvents(handle, "dedupe_key=feishu%3Amessage%3Aom_message_1");

      expect(first.status).toBe(202);
      expect(replay.status).toBe(202);
      expect(replayBody.event_id).toBe(firstBody.event_id);
      expect(events.map((event) => event.id)).toEqual([firstBody.event_id]);
    } finally {
      database.close();
    }
  });
});

async function fixtureHandler(projectMappings = ""): Promise<{
  database: RunnerDatabase;
  handle: (request: Request) => Promise<Response>;
}> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-feishu-inbox-"));
  tempRoots.push(root);
  const database = await openDatabase({ stateDir: join(root, "state") });
  const config = buildConfig({
    feishuAppId: "cli_app_id",
    feishuAppSecret: "app-secret-value",
    feishuProjectMappings: projectMappings,
    feishuVerificationToken: "verify-token"
  });
  const router = createDefaultRouter({ config, database });
  return { database, handle: createRequestHandler(router, config.authToken) };
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

async function postFeishu(handle: (request: Request) => Promise<Response>, body: unknown): Promise<Response> {
  return handle(new Request(`${BASE_URL}/api/integrations/feishu/events`, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "POST"
  }));
}

function messageEvent(input: {
  mentions?: Array<Record<string, unknown>>;
  text?: string;
} = {}): Record<string, unknown> {
  return {
    header: { event_id: "event-v2-1", event_type: "im.message.receive_v1", token: "verify-token" },
    event: {
      message: {
        chat_id: "oc_group",
        chat_type: "group",
        content: JSON.stringify({ text: input.text ?? "@PI implement it" }),
        create_time: "1781244167890",
        mentions: input.mentions ?? [{ id: "ou_bot", name: "PI", tenant_key: "tenant_a" }],
        message_id: "om_message_1"
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
