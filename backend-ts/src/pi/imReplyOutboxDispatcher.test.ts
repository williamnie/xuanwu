import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildFeishuConnectorConfig } from "../integrations/feishu.ts";
import { FeishuClientError } from "../integrations/feishuClient.ts";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { approveImReplyDraft, createImReplyDraft, getSyncOutbox } from "../db/repositories/imReplyOutbox.ts";
import { upsertPiApprovalRequest } from "../db/repositories/pi.ts";
import { dispatchFeishuOutbox, type FeishuMessageSender } from "./imReplyOutboxDispatcher.ts";

const tempRoots: string[] = [];
const NOW = new Date("2026-06-12T08:00:00Z");

afterEach(async () => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) await rm(root, { recursive: true, force: true });
  }
});

describe("IM reply outbox dispatcher", () => {
  test("sends approved Feishu draft once and records Feishu message id", async () => {
    const database = await fixtureDatabase();
    let outboxId = 0;
    const sender = new FakeFeishuSender([{ messageId: "om_sent_1" }], () => {
      expect(getSyncOutbox(database, outboxId)?.status).toBe("sending");
    });
    try {
      const outbox = createApprovedOutbox(database);
      outboxId = outbox.id;
      expect(outbox.status).toBe("pending");

      const first = await dispatchFeishuOutbox({ database, sender, config: config("oc_group"), now: NOW });
      const second = await dispatchFeishuOutbox({ database, sender, config: config("oc_group"), now: NOW });
      const stored = getSyncOutbox(database, outbox.id);

      expect(first).toMatchObject({ failed: 0, retry: 0, sent: 1 });
      expect(second).toMatchObject({ processed: 0, sent: 0 });
      expect(sender.calls).toEqual([{ receiveId: "oc_group", receiveIdType: "chat_id", text: "已创建 issue" }]);
      expect(stored).toMatchObject({
        attempt_count: 1,
        feishu_message_id: "om_sent_1",
        last_error: "",
        status: "sent"
      });
    } finally {
      database.close();
    }
  });

  test("sends approval outbox as an interactive card with idempotent approval actions", async () => {
    const database = await fixtureDatabase();
    const sender = new FakeFeishuSender([{ messageId: "om_card_1" }]);
    try {
      createApprovalRequest(database, "approval-card-1");
      const outbox = createApprovedOutbox(database, {
        approvalActionID: "approval-card-1",
        content: "Pi：issue #1 需要 Codex 授权才能继续。"
      });

      const result = await dispatchFeishuOutbox({ database, sender, config: config("oc_group"), now: NOW });
      const stored = getSyncOutbox(database, outbox.id);
      const cardText = JSON.stringify(sender.cardCalls[0]?.card ?? {});

      expect(result).toMatchObject({ failed: 0, retry: 0, sent: 1 });
      expect(sender.calls).toEqual([]);
      expect(sender.cardCalls).toHaveLength(1);
      expect(sender.cardCalls[0]).toMatchObject({ receiveId: "oc_group", receiveIdType: "chat_id" });
      expect(cardText).toContain("approval-card-1");
      expect(cardText).toContain("批准一次");
      expect(cardText).toContain("本 session 批准");
      expect(stored).toMatchObject({ feishu_message_id: "om_card_1", status: "sent" });
    } finally {
      database.close();
    }
  });

  test("fails permanently on Feishu auth or permission errors", async () => {
    const database = await fixtureDatabase();
    const sender = new FakeFeishuSender([new FeishuClientError("permission denied", { kind: "auth", status: 401 })]);
    try {
      const outbox = createApprovedOutbox(database);
      const result = await dispatchFeishuOutbox({ database, sender, config: config("oc_group"), now: NOW });
      const stored = getSyncOutbox(database, outbox.id);

      expect(result).toMatchObject({ failed: 1, sent: 0 });
      expect(stored).toMatchObject({ attempt_count: 1, status: "failed" });
      expect(stored?.last_error).toContain("permission denied");
    } finally {
      database.close();
    }
  });

  test("keeps retry cooldown for Feishu rate limits and does not send during cooldown", async () => {
    const database = await fixtureDatabase();
    const sender = new FakeFeishuSender([
      new FeishuClientError("rate limited", { kind: "rate_limited", retryAfterSeconds: 60, status: 429 }),
      { messageId: "om_sent_after_retry" }
    ]);
    try {
      const outbox = createApprovedOutbox(database);
      const rateLimited = await dispatchFeishuOutbox({ database, sender, config: config("oc_group"), now: NOW });
      const skipped = await dispatchFeishuOutbox({ database, sender, config: config("oc_group"), now: new Date("2026-06-12T08:00:30Z") });
      const sent = await dispatchFeishuOutbox({ database, sender, config: config("oc_group"), now: new Date("2026-06-12T08:01:01Z") });
      const stored = getSyncOutbox(database, outbox.id);

      expect(rateLimited).toMatchObject({ retry: 1, sent: 0 });
      expect(skipped).toMatchObject({ processed: 0, sent: 0 });
      expect(sent).toMatchObject({ sent: 1 });
      expect(sender.calls).toHaveLength(2);
      expect(stored).toMatchObject({
        attempt_count: 2,
        feishu_message_id: "om_sent_after_retry",
        retry_after_seconds: 0,
        status: "sent"
      });
    } finally {
      database.close();
    }
  });

  test("stops retrying network failures after max attempts", async () => {
    const database = await fixtureDatabase();
    const sender = new FakeFeishuSender([
      new FeishuClientError("socket closed", { kind: "temporary" }),
      new FeishuClientError("socket closed", { kind: "temporary" })
    ]);
    try {
      const outbox = createApprovedOutbox(database, { maxAttempts: 2 });

      await dispatchFeishuOutbox({ database, sender, config: config("oc_group"), now: NOW });
      const final = await dispatchFeishuOutbox({ database, sender, config: config("oc_group"), now: new Date("2026-06-12T08:00:11Z") });
      const stored = getSyncOutbox(database, outbox.id);

      expect(final).toMatchObject({ failed: 1 });
      expect(sender.calls).toHaveLength(2);
      expect(stored).toMatchObject({ attempt_count: 2, status: "failed" });
    } finally {
      database.close();
    }
  });

  test("checks approval and Feishu allowlist policy before sending", async () => {
    const database = await fixtureDatabase();
    const sender = new FakeFeishuSender([{ messageId: "om_should_not_send" }]);
    try {
      const outbox = createApprovedOutbox(database);
      const result = await dispatchFeishuOutbox({ database, sender, config: config("oc_other"), now: NOW });
      const stored = getSyncOutbox(database, outbox.id);

      expect(result).toMatchObject({ failed: 1, sent: 0 });
      expect(sender.calls).toEqual([]);
      expect(stored).toMatchObject({ status: "failed" });
      expect(stored?.last_error).toContain("chat is not allowed");
    } finally {
      database.close();
    }
  });

  test("does not send if the original draft approval was revoked", async () => {
    const database = await fixtureDatabase();
    const sender = new FakeFeishuSender([{ messageId: "om_should_not_send" }]);
    try {
      const outbox = createApprovedOutbox(database);
      database.sqlite.run("update im_reply_drafts set status='rejected' where id=?", [outbox.reply_draft_id]);

      const result = await dispatchFeishuOutbox({ database, sender, config: config("oc_group"), now: NOW });
      const stored = getSyncOutbox(database, outbox.id);

      expect(result).toMatchObject({ failed: 1, sent: 0 });
      expect(sender.calls).toEqual([]);
      expect(stored).toMatchObject({ status: "failed" });
      expect(stored?.last_error).toContain("reply draft is not approved");
    } finally {
      database.close();
    }
  });
});

class FakeFeishuSender implements FeishuMessageSender {
  calls: Array<{ receiveId: string; receiveIdType: string; text: string }> = [];
  cardCalls: Array<{ card: Record<string, unknown>; receiveId: string; receiveIdType: string }> = [];
  constructor(
    private readonly outcomes: Array<{ messageId: string } | Error>,
    private readonly onSend: () => void = () => {}
  ) {}

  async sendInteractiveCard(input: {
    card: Record<string, unknown>;
    receiveId: string;
    receiveIdType: string;
  }): Promise<{ messageId: string }> {
    this.cardCalls.push(input);
    return this.nextOutcome();
  }

  async sendTextMessage(input: { receiveId: string; receiveIdType: string; text: string }): Promise<{ messageId: string }> {
    this.calls.push(input);
    return this.nextOutcome();
  }

  private nextOutcome(): { messageId: string } {
    this.onSend();
    const next = this.outcomes.shift();
    if (next instanceof Error) throw next;
    if (!next) throw new Error("unexpected fake send");
    return next;
  }
}

async function fixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-im-dispatcher-"));
  tempRoots.push(root);
  return openDatabase({ stateDir: join(root, "state") });
}

function createApprovedOutbox(
  database: RunnerDatabase,
  options: { approvalActionID?: string; content?: string; maxAttempts?: number } = {}
) {
  const draft = createImReplyDraft(database, {
    approval_action_id: options.approvalActionID,
    content: options.content ?? "已创建 issue",
    source: "feishu",
    status: "pending",
    target_chat_id: "oc_group",
    target_message_id: "om_message_1"
  }, NOW);
  const { outbox } = approveImReplyDraft(database, draft.id, NOW);
  if (options.maxAttempts) {
    database.sqlite.run("update sync_outbox set max_attempts=? where id=?", [options.maxAttempts, outbox.id]);
  }
  return getSyncOutbox(database, outbox.id)!;
}

function createApprovalRequest(database: RunnerDatabase, approvalID: string): void {
  upsertPiApprovalRequest(database, {
    approval_id: approvalID,
    approval_source: "codex_provider_event",
    issue_id: 1,
    project_id: "demo",
    provider: "codex",
    provider_approval_id: approvalID,
    request_summary: "command=git status",
    request_type: "command",
    status: "delivered",
    thread_id: "thread-approval"
  });
}

function config(allowedChatIds: string) {
  return buildFeishuConnectorConfig({
    feishuAllowedChatIds: allowedChatIds,
    feishuAppId: "cli_app_id",
    feishuAppSecret: "app-secret-value",
    feishuVerificationToken: "verify-token"
  });
}
