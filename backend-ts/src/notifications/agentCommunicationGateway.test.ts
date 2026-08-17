import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { listExternalLinksByExternal } from "../db/repositories/externalLinks.ts";
import { createIssue } from "../db/repositories/issueCreate.ts";
import { listSyncOutbox } from "../db/repositories/imReplyOutbox.ts";
import { listPiNotificationIntents } from "../db/repositories/pi.ts";
import { runAgentCommunicationGatewayOnce } from "./agentCommunicationGateway.ts";
import { routeNotification } from "./unifiedNotificationPipeline.ts";

const roots: string[] = [];

afterEach(async () => {
  while (roots.length > 0) await rm(roots.pop()!, { recursive: true, force: true });
});

describe("Agent-first notification communication", () => {
  test("batches related intents and writes only the Agent message to outbox", async () => {
    const db = await fixture();
    try {
      const issue = createIssue(db, { project_id: "demo", status: "in_progress", title: "Agent-first batch" });
      stage(db, issue.id, "issue_start", "started", "event-start");
      stage(db, issue.id, "issue_pending_verification", "waiting for verification", "event-verify");

      let seen = 0;
      const result = await runAgentCommunicationGatewayOnce(db, {
        decide: async ({ intents }) => {
          seen = intents.length;
          return {
            decision: "send",
            message: "这项工作已经完成检查，现在只需要你决定是否开始验收。回复“验收”或“稍后”。",
            rationale: "one human decision remains"
          };
        },
        now: new Date("2026-07-19T12:00:00.000Z")
      });

      const outbox = listSyncOutbox(db, { source: "feishu" });
      const intents = listPiNotificationIntents(db, { issueId: issue.id });
      expect(seen).toBe(2);
      expect(result).toMatchObject({ fallback: 0, groups: 1, intents: 2, queued: 1, suppressed: 0 });
      expect(outbox).toHaveLength(1);
      expect(outbox[0]?.content).toContain("回复“验收”或“稍后”");
      expect(outbox[0]?.content).not.toContain("pending_verification");
      expect(listExternalLinksByExternal(db, {
        externalID: "event-start",
        externalType: "fixture_agent_communication",
        source: "feishu"
      })).toHaveLength(1);
      expect(new Set(intents.map((intent) => intent.state))).toEqual(new Set(["sent"]));
      expect(new Set(intents.map((intent) => intent.sent_outbox_id))).toEqual(new Set([outbox[0]?.id]));
    } finally {
      db.close();
    }
  });

  test("lets the Agent suppress routine lifecycle noise", async () => {
    const db = await fixture();
    try {
      const issue = createIssue(db, { project_id: "demo", status: "in_progress", title: "Routine progress" });
      stage(db, issue.id, "issue_start", "executor started", "event-routine");

      const result = await runAgentCommunicationGatewayOnce(db, {
        decide: async () => ({ decision: "suppress", message: "", rationale: "routine progress" })
      });

      expect(result).toMatchObject({ fallback: 0, queued: 0, suppressed: 1 });
      expect(listSyncOutbox(db)).toHaveLength(0);
      expect(listPiNotificationIntents(db, { issueId: issue.id })[0]).toMatchObject({
        decision: "suppress",
        error: "agent_suppressed:routine progress",
        state: "suppressed"
      });
    } finally {
      db.close();
    }
  });

  test("does not let the Agent suppress an explicit completion watch delivery", async () => {
    const db = await fixture();
    try {
      const issue = createIssue(db, { project_id: "demo", status: "done", title: "Explicit completion watch" });
      stage(db, issue.id, "automation_watch_terminal", "你订阅的工作已经完成。", "event-watch");

      const result = await runAgentCommunicationGatewayOnce(db, {
        decide: async () => ({ decision: "suppress", message: "", rationale: "routine watch completion" })
      });

      const outbox = listSyncOutbox(db, { source: "feishu" });
      expect(result).toMatchObject({ fallback: 0, queued: 1, suppressed: 0 });
      expect(outbox).toHaveLength(1);
      expect(outbox[0]?.content).toBe("你订阅的工作已经完成。");
      expect(listPiNotificationIntents(db, { issueId: issue.id })[0]).toMatchObject({
        error: "",
        state: "sent",
        sent_outbox_id: outbox[0]?.id
      });
    } finally {
      db.close();
    }
  });

  test("uses one rate-limited fallback when the Agent is unavailable", async () => {
    const db = await fixture();
    try {
      const issue = createIssue(db, { project_id: "demo", status: "failed", title: "Needs a decision" });
      stage(db, issue.id, "pi_needs_user", "provider authorization expired", "event-actionable", true);

      const now = new Date("2026-07-19T12:00:00.000Z");
      const first = await runAgentCommunicationGatewayOnce(db, {
        decide: async () => { throw new Error("provider initialize timeout"); },
        now
      });
      stage(db, issue.id, "pi_needs_user", "provider still unavailable", "event-actionable-2", true);
      const second = await runAgentCommunicationGatewayOnce(db, {
        decide: async () => ({ decision: "suppress", message: "", rationale: "invalid suppression" }),
        now: new Date("2026-07-19T12:05:00.000Z")
      });

      const outbox = listSyncOutbox(db, { source: "feishu" });
      expect(first).toMatchObject({ failed: 1, fallback: 1 });
      expect(second).toMatchObject({ failed: 1, fallback: 0 });
      expect(outbox).toHaveLength(1);
      expect(outbox[0]?.content).toContain("Stone 当前不可用");
      expect(outbox[0]?.content).toContain("暂停这批自动状态通知");
    } finally {
      db.close();
    }
  });
});

function stage(
  db: RunnerDatabase,
  issueID: number,
  kind: string,
  content: string,
  eventID: string,
  requiresUser = false
): void {
  const result = routeNotification(db, {
    content,
    idempotencyKey: `fixture:${eventID}`,
    issueID,
    kind,
    notificationID: eventID,
    notificationType: "fixture_agent_communication",
    projectID: "demo",
    requiresUser,
    routes: [{ channel: "feishu", chatID: "oc_agent_first" }],
    severity: requiresUser ? "needs_user" : "info",
    sourceEventID: eventID,
    sourceEventType: "fixture.notification",
    summary: content
  })[0];
  expect(result).toMatchObject({ queued: true, reason: "agent_pending" });
}

async function fixture(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "agent-communication-"));
  roots.push(root);
  const db = await openDatabase({ stateDir: join(root, "state") });
  db.sqlite.run(`insert into projects (id, name, cwd, provider, provider_config_json, sort_order, created_at, updated_at)
    values (?, ?, ?, ?, ?, ?, ?, ?)`, [
    "demo", "Demo", join(root, "project"), "codex", '{"capabilities":["issue_execution"]}', 1,
    "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"
  ]);
  return db;
}
