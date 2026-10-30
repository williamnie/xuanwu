import { afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../../db/database.ts";
import { createExternalEvent } from "../../db/repositories/externalEvents.ts";
import { createExternalLink } from "../../db/repositories/externalLinks.ts";
import { createIssue } from "../../db/repositories/issueCreate.ts";
import { recordIssueEvent } from "../../db/repositories/issueEvents.ts";
import { createHumanReviewRequest } from "../../domain/review/humanReview.ts";
import { type FeishuMessageSender } from "./feishuOutboxDispatcherCompat.ts";
import { useDatabaseCleanup } from "../../testing/harness.ts";



export function createTestFixture() {
  const trackDatabase = useDatabaseCleanup();

  const tempRoots: string[] = [];

  const BASE_URL = "http://127.0.0.1:3008";

  afterEach(async () => {
    while (tempRoots.length > 0) {
      const root = tempRoots.pop();
      if (root) await rm(root, { recursive: true, force: true });
    }
  });

  function pendingRequiredHandoffReview(db: RunnerDatabase, issueID: number) {
    recordIssueEvent(db, issueID, "issue.handoff_policy_set.v1", {
      policy: "required",
      reason: "notification fixture"
    });
    return createHumanReviewRequest(db, issueID, {
      question: "是否接受当前验证结果？"
    });
  }

  async function fixtureDatabase(): Promise<RunnerDatabase> {
    const root = await mkdtemp(join(tmpdir(), "xuanwu-feishu-notify-"));
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
      normalized_message: { chat_id: "oc_group", message_id: "om_task" },
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

  class FakeFeishuSender implements FeishuMessageSender {
    calls: Array<{ receiveId: string; receiveIdType: string; text: string }> = [];
  
    async sendTextMessage(input: { receiveId: string; receiveIdType: string; text: string }): Promise<{ messageId: string }> {
      this.calls.push(input);
      return { messageId: `om_auto_sent_${this.calls.length}` };
    }
  }
  return { trackDatabase, tempRoots, BASE_URL, pendingRequiredHandoffReview, fixtureDatabase, linkedFeishuIssue, FakeFeishuSender };
}
export type TestFixture = ReturnType<typeof createTestFixture>;
