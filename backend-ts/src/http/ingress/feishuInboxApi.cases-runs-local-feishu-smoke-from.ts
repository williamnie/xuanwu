import { expect, test } from "bun:test";
import type { TestFixture } from "./feishuInboxApi.testFixture.ts";

export function registerRunsLocalFeishuSmokeFromCases(testScope: TestFixture) {
  const { fixtureHandler, getExternalEvents, getExternalEvent, getReplyDrafts, getSyncOutbox, approveReplyDraft, getIssue, postFeishu, createIssueFromExternalEvent, insertProject, messageEvent } = testScope;
  test("runs local Feishu smoke from challenge to reply draft and outbox without leaking secrets", async () => {
      const { database, handle, root } = await fixtureHandler("chat:oc_group=demo");
      await insertProject(database, root, "demo");
      const challenge = await postFeishu(handle, { challenge: "challenge-code", token: "verify-token", type: "url_verification" });
      expect(await challenge.json()).toEqual({ challenge: "challenge-code" });
  
      const inbox = await postFeishu(handle, messageEvent({ text: "@PI 帮我实现这个折叠面板功能", threadId: "omt_thread_1" }));
      const inboxBody = await inbox.json() as Record<string, unknown>;
      const eventID = Number(inboxBody.event_id);
      expect(inbox.status).toBe(202);
      expect(inboxBody).toMatchObject({ ok: true, normalized_summary: { project_id: "" } });
  
      const inboxEvent = await getExternalEvent(handle, eventID);
      expect(inboxEvent).toMatchObject({ project_id: "", source: "feishu", status: "inbox_only" });
      expect(inboxEvent.summary).toMatchObject({
        attention_decision: { decision: "inbox_only", should_create_issue_proposal: false }
      });
  
      const proposal = await createIssueFromExternalEvent(handle, eventID, { project_id: "demo" });
      const proposalBody = await proposal.json() as Record<string, unknown>;
      expect(proposal.status).toBe(201);
      expect(proposalBody).toMatchObject({ created: true });
  
      const issue = await getIssue(handle, Number(proposalBody.issue_id));
      expect(issue).toMatchObject({ project_id: "demo", status: "triage" });
      expect(String(issue.description)).toContain("message=om_message_1");
  
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
    });
  
  test("persists normalized message events into the external event inbox", async () => {
      const { database, handle } = await fixtureHandler("chat:oc_group=demo");
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
        status: "inbox_only"
      });
      expect(events[0].raw_payload_ref).toMatch(/^sha256:/);
      expect(events[0].summary).toMatchObject({
        attention_decision: {
          decision: "inbox_only",
          project_id: "",
          reason: "trusted_message_forwarded_to_pi"
        },
        chat_id: "oc_group",
        message_id: "om_message_1",
        project_id: "",
        text_length: 16
      });
      expect(detail).toEqual(events[0]);
    });
  
  test("keeps unmatched Feishu messages as unassigned inbox events", async () => {
      const { database, handle } = await fixtureHandler();
      const response = await postFeishu(handle, messageEvent());
      const events = await getExternalEvents(handle, "source=feishu");
  
      expect(response.status).toBe(202);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        project_id: "",
        status: "inbox_only",
        summary: {
          attention_decision: {
            decision: "inbox_only",
            needs_project: false,
            reason: "trusted_message_forwarded_to_pi"
          }
        }
      });
    });
  
  test("does not create proposal decisions for ordinary chat noise", async () => {
      const { database, handle } = await fixtureHandler("chat:oc_group=demo");
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
            reason: "no_trusted_attention",
            should_create_issue_proposal: false
          }
        }
      });
    });
  
  test("replayed Feishu message_id does not create duplicate inbox records", async () => {
      const { database, handle } = await fixtureHandler();
      const first = await postFeishu(handle, messageEvent());
      const replay = await postFeishu(handle, messageEvent());
      const firstBody = await first.json() as Record<string, unknown>;
      const replayBody = await replay.json() as Record<string, unknown>;
      const events = await getExternalEvents(handle, "dedupe_key=feishu%3Amessage%3Aom_message_1");
  
      expect(first.status).toBe(202);
      expect(replay.status).toBe(202);
      expect(replayBody.event_id).toBe(firstBody.event_id);
      expect(events.map((event) => event.id)).toEqual([firstBody.event_id]);
    });
  
  test("creates a triage runner issue from a Feishu inbox event and records an external link", async () => {
      const { database, handle, root } = await fixtureHandler("chat:oc_group=demo");
      await insertProject(database, root, "demo");
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
      expect(String(issue.description)).toContain("## 一句话目标");
      expect(String(issue.description)).toContain("message=om_message_1");
      expect(String(issue.description)).toContain("## 验收标准");
      expect(String(issue.description)).toContain("## 自动验证");
      expect(link).toMatchObject({
        conversation_id: "omt_thread_1",
        external_id: "om_message_1",
        external_type: "feishu_message",
        issue_id: issue.id,
        relationship: "created_issue",
        source: "feishu"
      });
    });
  
  test("repeated create issue action returns the already linked issue", async () => {
      const { database, handle, root } = await fixtureHandler("chat:oc_group=demo");
      await insertProject(database, root, "demo");
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
    });
}
