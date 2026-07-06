import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
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
  test("runs local Feishu smoke from challenge to reply draft and outbox without leaking secrets", async () => {
    const { database, handle, root } = await fixtureHandler("chat:oc_group=demo");
    await insertProject(database, root, "demo");
    try {
      const challenge = await postFeishu(handle, { challenge: "challenge-code", token: "verify-token", type: "url_verification" });
      expect(await challenge.json()).toEqual({ challenge: "challenge-code" });

      const inbox = await postFeishu(handle, messageEvent({ text: "@PI 帮我实现这个折叠面板功能", threadId: "omt_thread_1" }));
      const inboxBody = await inbox.json() as Record<string, unknown>;
      const eventID = Number(inboxBody.event_id);
      expect(inbox.status).toBe(202);
      expect(inboxBody).toMatchObject({ ok: true, normalized_summary: { project_id: "" } });

      const inboxEvent = await getExternalEvent(handle, eventID);
      expect(inboxEvent).toMatchObject({ project_id: "", source: "feishu", status: "needs_project" });
      expect(inboxEvent.summary).toMatchObject({
        attention_decision: { decision: "ask_clarification", should_create_issue_proposal: false }
      });

      const proposal = await createIssueFromExternalEvent(handle, eventID, { project_id: "demo" });
      const proposalBody = await proposal.json() as Record<string, unknown>;
      expect(proposal.status).toBe(201);
      expect(proposalBody).toMatchObject({ created: true });

      const issue = await getIssue(handle, Number(proposalBody.issue_id));
      expect(issue).toMatchObject({ project_id: "demo", status: "triage" });
      expect(String(issue.description)).toContain("PI repo_context_pack");

      const drafts = await getReplyDrafts(handle, "source=feishu");
      expect(drafts).toHaveLength(1);
      expect(drafts[0]).toMatchObject({
        issue_id: issue.id,
        source: "feishu",
        status: "pending",
        target_chat_id: "oc_group",
        target_thread_id: "omt_thread_1"
      });

      const approved = await approveReplyDraft(handle, Number(drafts[0].id));
      expect(approved.status).toBe(200);
      const outbox = await getSyncOutbox(handle, "source=feishu");
      expect(outbox).toHaveLength(1);
      expect(outbox[0]).toMatchObject({
        issue_id: issue.id,
        reply_draft_id: drafts[0].id,
        source: "feishu",
        status: "pending"
      });

      const smokeText = JSON.stringify({ inboxBody, inboxEvent, issue, drafts, outbox });
      expect(smokeText).not.toContain("verify-token");
      expect(smokeText).not.toContain("app-secret-value");
      expect(smokeText).not.toContain(root);
    } finally {
      database.close();
    }
  });

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
        project_id: "",
        source: "feishu",
        status: "needs_project"
      });
      expect(events[0].raw_payload_ref).toMatch(/^sha256:/);
      expect(events[0].summary).toMatchObject({
        attention_decision: {
          decision: "ask_clarification",
          project_id: "",
          reason: "needs_project"
        },
        chat_id: "oc_group",
        message_id: "om_message_1",
        project_id: "",
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
        project_id: "",
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

  test("creates a triage runner issue from a Feishu inbox event and records an external link", async () => {
    const { database, handle, root } = await fixtureHandler("chat:oc_group=demo");
    await insertProject(database, root, "demo");
    try {
      const inbox = await postFeishu(handle, messageEvent({
        attachments: [{ file_key: "file-key-1", file_name: "spec.png", file_size: 1234, mime_type: "image/png", type: "image" }],
        text: "@PI 帮我实现这个折叠面板功能",
        threadId: "omt_thread_1"
      }));
      const inboxBody = await inbox.json() as Record<string, unknown>;

      const response = await createIssueFromExternalEvent(handle, Number(inboxBody.event_id), { project_id: "demo" });
      const body = await response.json() as Record<string, unknown>;
      const issue = await getIssue(handle, Number(body.issue_id));
      const link = database.sqlite.query<Record<string, unknown>, []>(
        "select source, external_id, external_type, issue_id, conversation_id, relationship from external_links"
      ).get();

      expect(response.status).toBe(201);
      expect(body).toMatchObject({ created: true, issue_id: issue.id });
      expect(issue).toMatchObject({ project_id: "demo", status: "triage" });
      expect(String(issue.description)).toContain("## 外部来源");
      expect(String(issue.description)).toContain("Source: feishu");
      expect(String(issue.description)).toContain("Message ID: om_message_1");
      expect(String(issue.description)).toContain("Chat: oc_group");
      expect(String(issue.description)).toContain("Thread: omt_thread_1");
      expect(String(issue.description)).toContain("spec.png");
      expect(String(issue.description)).toContain("## 需求理解");
      expect(String(issue.description)).toContain("PI repo_context_pack");
      expect(String(issue.description)).toContain("## 验收标准");
      expect(String(issue.description)).toContain("## 验证建议");
      expect(link).toMatchObject({
        conversation_id: "omt_thread_1",
        external_id: "om_message_1",
        external_type: "feishu_message",
        issue_id: issue.id,
        relationship: "created_issue",
        source: "feishu"
      });
    } finally {
      database.close();
    }
  });

  test("repeated create issue action returns the already linked issue", async () => {
    const { database, handle, root } = await fixtureHandler("chat:oc_group=demo");
    await insertProject(database, root, "demo");
    try {
      const inbox = await postFeishu(handle, messageEvent());
      const inboxBody = await inbox.json() as Record<string, unknown>;

      const first = await createIssueFromExternalEvent(handle, Number(inboxBody.event_id), { project_id: "demo" });
      const duplicate = await createIssueFromExternalEvent(handle, Number(inboxBody.event_id), { project_id: "demo" });
      const firstBody = await first.json() as Record<string, unknown>;
      const duplicateBody = await duplicate.json() as Record<string, unknown>;

      expect(first.status).toBe(201);
      expect(duplicate.status).toBe(200);
      expect(duplicateBody).toMatchObject({ created: false, issue_id: firstBody.issue_id });
      expect(database.sqlite.query("select count(*) as count from issues").get()).toEqual({ count: 1 });
      expect(database.sqlite.query("select count(*) as count from external_links").get()).toEqual({ count: 1 });
    } finally {
      database.close();
    }
  });
});

async function fixtureHandler(projectMappings = ""): Promise<{
  database: RunnerDatabase;
  handle: (request: Request) => Promise<Response>;
  root: string;
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
