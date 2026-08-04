import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { approveImReplyDraft, createImReplyDraft } from "../db/repositories/imReplyOutbox.ts";
import { createPiNotificationIntent } from "../db/repositories/pi.ts";
import { createHumanReviewRequest } from "../domain/review/humanReview.ts";
import { normalizeFeishuMessageEvent } from "./feishu.ts";
import { resolveFeishuActionTarget } from "./feishuActionTarget.ts";

const roots: string[] = [];

afterEach(async () => {
  while (roots.length > 0) await rm(roots.pop()!, { recursive: true, force: true });
});

describe("Feishu actionable notification target", () => {
  test("binds a short reply to the only currently open actionable notification, not an older Issue", async () => {
    const db = await fixture();
    try {
      insertProject(db);
      insertIssue(db, 828, "done");
      insertIssue(db, 841, "needs_user");
      createHumanReviewRequest(db, 841, { kind: "acceptance", question: "接受离线验收吗？" });
      insertIntent(db, 828, "2026-08-01T18:40:35Z");
      insertIntent(db, 841, "2026-08-02T05:08:19Z");

      expect(resolveFeishuActionTarget(db, event("接受，这种不用管"))).toMatchObject({
        issueID: 841,
        projectID: "demo",
        source: "single_open_actionable_notification"
      });
    } finally {
      db.close();
    }
  });

  test("fails closed when the same chat has multiple open actionable Issues", async () => {
    const db = await fixture();
    try {
      insertProject(db);
      for (const id of [841, 842]) {
        insertIssue(db, id, "needs_user");
        createHumanReviewRequest(db, id, { kind: "acceptance", question: `接受 #${id} 吗？` });
        insertIntent(db, id, `2026-08-02T05:0${id - 840}:19Z`);
      }

      expect(resolveFeishuActionTarget(db, event("接受"))).toEqual({
        issueID: 0,
        projectID: "",
        source: "none",
        sourceRef: ""
      });
    } finally {
      db.close();
    }
  });

  test("does not bind an unrelated new topic merely because one actionable Issue is open", async () => {
    const db = await fixture();
    try {
      insertProject(db);
      insertIssue(db, 841, "needs_user");
      createHumanReviewRequest(db, 841, { kind: "acceptance", question: "接受离线验收吗？" });
      insertIntent(db, 841, "2026-08-02T05:08:19Z");

      expect(resolveFeishuActionTarget(db, event("帮我新建一个图片压缩任务"))).toEqual({
        issueID: 0,
        projectID: "",
        source: "none",
        sourceRef: ""
      });
    } finally {
      db.close();
    }
  });

  test("binds an explicit reply to the notification message even without approval keywords", async () => {
    const db = await fixture();
    try {
      insertProject(db);
      insertIssue(db, 841, "needs_user");
      createHumanReviewRequest(db, 841, { kind: "acceptance", question: "接受离线验收吗？" });
      insertSentOutbox(db, 841, "om-notification-841");

      expect(resolveFeishuActionTarget(db, event("这种情况按之前说的办", {
        threadID: "om-notification-841"
      }))).toMatchObject({
        issueID: 841,
        projectID: "demo",
        source: "replied_notification"
      });
    } finally {
      db.close();
    }
  });
});

async function fixture(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "xuanwu-feishu-action-target-"));
  roots.push(root);
  return openDatabase({ stateDir: join(root, "state") });
}

function insertProject(db: RunnerDatabase): void {
  db.sqlite.run(`insert into projects (id, name, cwd, created_at, updated_at)
    values ('demo', 'Demo', '/tmp/demo', ?, ?)`, ["2026-08-01T00:00:00Z", "2026-08-01T00:00:00Z"]);
}

function insertIssue(db: RunnerDatabase, id: number, status: string): void {
  db.sqlite.run(`insert into issues (id, project_id, title, status, created_at, updated_at)
    values (?, 'demo', ?, ?, ?, ?)`, [id, `Issue ${id}`, status, "2026-08-01T00:00:00Z", "2026-08-01T00:00:00Z"]);
}

function insertIntent(db: RunnerDatabase, issueID: number, createdAt: string): void {
  const intent = createPiNotificationIntent(db, {
    id: `intent-${issueID}`,
    idempotency_key: `intent-${issueID}`,
    issue_id: issueID,
    kind: "pi_needs_user",
    project_id: "demo",
    requires_user: 1,
    state: "sent",
    target_channel: "feishu",
    target_chat_id: "oc_group"
  });
  db.sqlite.run("update pi_notification_intents set created_at=?, updated_at=? where id=?", [createdAt, createdAt, intent.id]);
}

function insertSentOutbox(db: RunnerDatabase, issueID: number, messageID: string): void {
  const draft = createImReplyDraft(db, {
    content: `Issue #${issueID} 需要处理`,
    created_by: "test",
    issue_id: issueID,
    risk: "low",
    source: "feishu",
    status: "pending",
    target_chat_id: "oc_group"
  });
  const { outbox } = approveImReplyDraft(db, draft.id);
  db.sqlite.run(
    "update sync_outbox set status='sent', feishu_message_id=?, sent_at=? where id=?",
    [messageID, "2026-08-02T05:08:25Z", outbox.id]
  );
}

function event(text: string, options: { rootID?: string; threadID?: string } = {}) {
  return normalizeFeishuMessageEvent({
    message: {
      chat_id: "oc_group",
      content: JSON.stringify({ text }),
      create_time: "1781244167890",
      message_id: `om-${text}`,
      root_id: options.rootID,
      parent_id: options.threadID
    },
    sender: { sender_id: { open_id: "ou-user" }, sender_type: "user" }
  });
}
