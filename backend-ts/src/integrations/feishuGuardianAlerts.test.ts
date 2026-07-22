import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { createExternalEvent } from "../db/repositories/externalEvents.ts";
import { createExternalLink } from "../db/repositories/externalLinks.ts";
import { createIssue } from "../db/repositories/issueCreate.ts";
import { createPiRunGroup, getPiGuardianAlert, upsertPiGuardianAlert } from "../db/repositories/pi.ts";
import { buildFeishuConnectorConfig } from "./feishu.ts";
import type { FeishuTextMessageInput, FeishuTextMessageResult } from "./feishuClient.ts";
import { sendDirectFeishuGuardianAlert } from "./feishuGuardianAlerts.ts";

const tempRoots: string[] = [];
const NOW = new Date("2026-06-23T01:00:00Z");
const NOW_TEXT = "2026-06-23T01:00:00Z";

afterEach(async () => {
  while (tempRoots.length > 0) {
    const path = tempRoots.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

describe("PI Guardian direct Feishu alert target routing", () => {
  test("keeps PI-handled system alerts in Guardian instead of routing them to the default chat", async () => {
    const db = await openFixtureDatabase();
    const sender = new FakeGuardianSender("om_default");
    try {
      const alert = upsertPiGuardianAlert(db, alertInput({
        alert_type: "digest_flush_stalled",
        id: "alert-default",
        message: "digest coordinator stalled",
        project_id: ""
      }));

      await sendDirectFeishuGuardianAlert(db, alert, {
        config: feishuConfig({
          feishuAllowedChatIds: "oc_default",
          feishuDefaultChatId: "oc_default"
        }),
        now: NOW,
        sender
      });

      expect(sender.calls).toHaveLength(0);
      expect(getPiGuardianAlert(db, alert.id)).toMatchObject({
        direct_feishu_message_id: "",
        direct_feishu_state: "not_attempted",
        status: "open",
        ui_visible: 1
      });
    } finally {
      db.close();
    }
  });

  test("routes an alert only after PI handling time is exhausted", async () => {
    const db = await openFixtureDatabase();
    const sender = new FakeGuardianSender("om_escalated");
    try {
      const inserted = upsertPiGuardianAlert(db, alertInput({
        alert_type: "digest_flush_stalled",
        id: "alert-escalated",
        message: "digest coordinator remains stalled",
        project_id: ""
      }));
      db.sqlite.run("update pi_guardian_alerts set created_at=? where id=?", [
        "2026-06-23T00:00:00Z", inserted.id
      ]);
      const alert = getPiGuardianAlert(db, inserted.id)!;

      await sendDirectFeishuGuardianAlert(db, alert, {
        config: feishuConfig({
          feishuAllowedChatIds: "oc_default",
          feishuDefaultChatId: "oc_default"
        }),
        now: NOW,
        sender
      });

      expect(sender.calls).toMatchObject([{ receiveId: "oc_default", receiveIdType: "chat_id" }]);
      expect(getPiGuardianAlert(db, alert.id)).toMatchObject({
        direct_feishu_message_id: "om_escalated",
        direct_feishu_state: "sent"
      });
    } finally {
      db.close();
    }
  });

  test("routes system alert to default user target when default chat is empty", async () => {
    const db = await openFixtureDatabase();
    const sender = new FakeGuardianSender("om_default_user");
    try {
      const alert = upsertPiGuardianAlert(db, alertInput({
        id: "alert-default-user",
        message: "system coordinator stalled",
        project_id: ""
      }));

      await sendDirectFeishuGuardianAlert(db, alert, {
        config: feishuConfig({
          feishuAllowedUserIds: "ou_default",
          feishuDefaultUserId: "ou_default"
        }),
        now: NOW,
        sender
      });

      expect(sender.calls).toMatchObject([{ receiveId: "ou_default", receiveIdType: "open_id" }]);
      expect(getPiGuardianAlert(db, alert.id)).toMatchObject({
        direct_feishu_message_id: "om_default_user",
        direct_feishu_state: "sent"
      });
    } finally {
      db.close();
    }
  });

  test("uses project mapping before default target", async () => {
    const db = await openFixtureDatabase();
    const sender = new FakeGuardianSender("om_project");
    try {
      insertProject(db, "demo");
      const alert = upsertPiGuardianAlert(db, alertInput({ id: "alert-project", project_id: "demo" }));

      await sendDirectFeishuGuardianAlert(db, alert, {
        config: feishuConfig({
          feishuAllowedChatIds: "oc_default,oc_project",
          feishuDefaultChatId: "oc_default",
          feishuProjectMappings: "chat:oc_project=demo"
        }),
        now: NOW,
        sender
      });

      expect(sender.calls).toMatchObject([{ receiveId: "oc_project", receiveIdType: "chat_id" }]);
    } finally {
      db.close();
    }
  });

  test("uses issue conversation target before project and default targets", async () => {
    const db = await openFixtureDatabase();
    const sender = new FakeGuardianSender("om_issue_reply");
    try {
      insertProject(db, "demo");
      const issueID = linkedFeishuIssue(db, "demo", "oc_issue");
      const alert = upsertPiGuardianAlert(db, alertInput({
        id: "alert-issue",
        issue_id: issueID,
        project_id: "demo"
      }));

      await sendDirectFeishuGuardianAlert(db, alert, {
        config: feishuConfig({
          feishuAllowedChatIds: "oc_default,oc_project,oc_issue",
          feishuDefaultChatId: "oc_default",
          feishuProjectMappings: "chat:oc_project=demo"
        }),
        now: NOW,
        sender
      });

      expect(sender.calls).toMatchObject([{ receiveId: "oc_issue", receiveIdType: "chat_id" }]);
    } finally {
      db.close();
    }
  });

  test("uses run group conversation target before project and default targets", async () => {
    const db = await openFixtureDatabase();
    const sender = new FakeGuardianSender("om_group_reply");
    try {
      insertProject(db, "demo");
      createPiRunGroup(db, {
        expected_issue_count: 1,
        id: "group-conversation",
        origin_conversation_id: "feishu-chat-oc_conversation-20260623",
        project_id: "demo"
      });
      const alert = upsertPiGuardianAlert(db, alertInput({
        id: "alert-conversation",
        project_id: "demo",
        run_group_id: "group-conversation"
      }));

      await sendDirectFeishuGuardianAlert(db, alert, {
        config: feishuConfig({
          feishuAllowedChatIds: "oc_default,oc_project,oc_conversation",
          feishuDefaultChatId: "oc_default",
          feishuProjectMappings: "chat:oc_project=demo"
        }),
        now: NOW,
        sender
      });

      expect(sender.calls).toMatchObject([{ receiveId: "oc_conversation", receiveIdType: "chat_id" }]);
    } finally {
      db.close();
    }
  });

  test("keeps UI-only fallback and records clear error when target is missing", async () => {
    const db = await openFixtureDatabase();
    const sender = new FakeGuardianSender("om_unexpected");
    try {
      const alert = upsertPiGuardianAlert(db, alertInput({ id: "alert-missing", project_id: "" }));

      await sendDirectFeishuGuardianAlert(db, alert, {
        config: feishuConfig(),
        now: NOW,
        sender
      });

      expect(sender.calls).toHaveLength(0);
      expect(getPiGuardianAlert(db, alert.id)).toMatchObject({
        direct_feishu_error: "missing direct Feishu target",
        direct_feishu_state: "retry",
        status: "open",
        ui_visible: 1
      });
    } finally {
      db.close();
    }
  });
});

async function openFixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-feishu-guardian-alerts-"));
  tempRoots.push(root);
  return openDatabase({ stateDir: join(root, "state") });
}

function alertInput(input: {
  alert_type?: string; id: string; issue_id?: number; message?: string; project_id: string;
  run_group_id?: string;
}) {
  return {
    alert_type: input.alert_type ?? "pi_runtime_down",
    id: input.id,
    issue_id: input.issue_id,
    message: input.message ?? "PI runtime unavailable",
    project_id: input.project_id,
    run_group_id: input.run_group_id,
    watchdog_seen_at: NOW_TEXT
  };
}

function feishuConfig(input: Record<string, unknown> = {}) {
  return buildFeishuConnectorConfig({
    feishuAppId: "cli_app_id",
    feishuAppSecret: "app-secret-value",
    ...input
  });
}

function insertProject(db: RunnerDatabase, id: string): void {
  db.sqlite.run(
    `insert into projects (id, name, cwd, created_at, updated_at)
     values (?, ?, ?, ?, ?)`,
    [id, id, `/tmp/${id}`, NOW_TEXT, NOW_TEXT]
  );
}

function linkedFeishuIssue(db: RunnerDatabase, projectID: string, chatID: string): number {
  const issue = createIssue(db, {
    project_id: projectID,
    status: "todo",
    title: "linked Feishu issue"
  });
  const event = createExternalEvent(db, {
    content: "please check",
    dedupe_key: "feishu:message:om_issue",
    external_id: "om_issue",
    normalized_message: { chat_id: chatID, message_id: "om_issue", thread_id: "om_thread" },
    source: "feishu"
  }, NOW);
  createExternalLink(db, {
    conversation_id: `feishu-chat-${chatID}-20260623`,
    external_event_id: event.id,
    external_id: "om_issue",
    external_type: "feishu_message",
    issue_id: issue.id,
    relationship: "related",
    source: "feishu"
  }, NOW);
  return issue.id;
}

class FakeGuardianSender {
  calls: FeishuTextMessageInput[] = [];
  constructor(private readonly messageID: string) {}

  async sendTextMessage(input: FeishuTextMessageInput): Promise<FeishuTextMessageResult> {
    this.calls.push(input);
    return { messageId: this.messageID };
  }
}
