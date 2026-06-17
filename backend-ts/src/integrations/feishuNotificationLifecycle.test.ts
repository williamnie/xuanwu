import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { createExternalEvent } from "../db/repositories/externalEvents.ts";
import { createExternalLink } from "../db/repositories/externalLinks.ts";
import { createIssue } from "../db/repositories/issueCreate.ts";
import { listSyncOutbox } from "../db/repositories/imReplyOutbox.ts";
import { createPiAction, createPiMemoryItem } from "../db/repositories/pi.ts";
import { getProject } from "../db/repositories/projects.ts";
import { updateIssue } from "../db/repositories/issueUpdate.ts";
import { EventBus } from "../events/bus.ts";
import { createPiRunnerActions } from "../pi/runnerActions.ts";
import type { ExecutorProvider, ProviderRunInput } from "../providers/types.ts";
import { runProjectLoopOnce } from "../runner/projectLoop.ts";
import {
  attachFeishuNotificationObservers,
  queueFeishuIssueStatusNotification,
  queueFeishuMemoryCandidateNotification
} from "./feishuNotifications.ts";

const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) await rm(root, { recursive: true, force: true });
  }
});

describe("Feishu lifecycle notifications", () => {
  test("queues one start notification across todo and in-progress status replays", async () => {
    const db = await fixtureDatabase();
    try {
      const issueID = linkedFeishuIssue(db);
      updateIssue(db, issueID, { status: "todo", error: "" });

      const todo = queueFeishuIssueStatusNotification(db, issueID);
      updateIssue(db, issueID, { status: "in_progress", error: "" });
      const inProgress = queueFeishuIssueStatusNotification(db, issueID);
      const replay = queueFeishuIssueStatusNotification(db, issueID);
      const outbox = listSyncOutbox(db, { source: "feishu" });

      expect(todo).toMatchObject({ queued: true, reason: "queued" });
      expect(inProgress).toMatchObject({ queued: false, reason: "duplicate" });
      expect(replay).toMatchObject({ queued: false, reason: "duplicate" });
      expect(outbox).toHaveLength(1);
      expect(outbox[0]?.content).toContain("准备启动");
      expect(outbox[0]?.content).toContain("issue #1");
    } finally {
      db.close();
    }
  });

  test("redacts failed notification details and includes an actionable next step", async () => {
    const db = await fixtureDatabase();
    try {
      const issueID = linkedFeishuIssue(db);
      updateIssue(db, issueID, {
        status: "failed",
        error: "Error: token=fixture-secret at /Users/example/private.ts\n    at run (/Users/example/app.ts:1:1)"
      });

      const result = queueFeishuIssueStatusNotification(db, issueID);
      const content = listSyncOutbox(db, { source: "feishu" })[0]?.content ?? "";

      expect(result).toMatchObject({ queued: true, reason: "queued" });
      expect(content).toContain("执行失败");
      expect(content).toContain("下一步");
      expect(content).toContain("[redacted]");
      expect(content).not.toContain("fixture-secret");
      expect(content).not.toContain("/Users/example");
      expect(content).not.toContain("at run");
    } finally {
      db.close();
    }
  });

  test("queues one memory candidate notice with approve and reject commands", async () => {
    const db = await fixtureDatabase();
    try {
      linkedFeishuIssue(db, { conversationID: "feishu-chat-oc_group-20260614" });
      createCandidate(db, "12345678-2222-4222-8222-123456789abc", "状态汇报使用简短中文 bullet");

      const event = memoryCandidateEvent("12345678-2222-4222-8222-123456789abc");
      const first = queueFeishuMemoryCandidateNotification(db, event);
      const second = queueFeishuMemoryCandidateNotification(db, event);
      const content = listSyncOutbox(db, { source: "feishu" })[0]?.content ?? "";

      expect(first).toMatchObject({ queued: true, reason: "queued" });
      expect(second).toMatchObject({ queued: false, reason: "duplicate" });
      expect(content).toContain("memory candidate");
      expect(content).toContain("/memory approve 12345678");
      expect(content).toContain("/memory reject 12345678");
      expect(content).toContain("状态汇报使用简短中文 bullet");
    } finally {
      db.close();
    }
  });

  test("observer uses PI action conversation as the start target and reuses it for completion", async () => {
    const db = await fixtureDatabase();
    const bus = new EventBus();
    const detach = attachFeishuNotificationObservers({ bus, database: db });
    try {
      const issue = createIssue(db, { project_id: "demo", title: "PI issue", status: "todo" });

      bus.publish({
        conversationId: "feishu-chat-oc_group-20260614",
        issueId: issue.id,
        payload: JSON.stringify({ action_id: "pi-enqueue-1", action_type: "issue.enqueue", status: "completed" }),
        projectId: "demo",
        type: "pi.action_completed"
      });
      updateIssue(db, issue.id, { error: "", status: "done" });
      bus.publish({ issueId: issue.id, payload: JSON.stringify({ status: "done" }), projectId: "demo", type: "issue.status_changed" });

      const outbox = listSyncOutbox(db, { source: "feishu" });
      expect(outbox).toHaveLength(2);
      expect(outbox.map((item) => item.target_chat_id)).toEqual(["oc_group", "oc_group"]);
      expect(outbox.map((item) => item.content).join("\n")).toContain("准备启动");
      expect(outbox.map((item) => item.content).join("\n")).toContain("已完成");
    } finally {
      detach();
      db.close();
    }
  });

  test("observer lets PI summarize auto-executed runner chat enqueue actions instead of sending per-issue start notifications", async () => {
    const db = await fixtureDatabase();
    const bus = new EventBus();
    const detach = attachFeishuNotificationObservers({ bus, database: db });
    try {
      const first = createIssue(db, { project_id: "demo", title: "Batch A", status: "triage" });
      createIssue(db, { project_id: "demo", title: "Batch B", status: "triage" });
      createIssue(db, { project_id: "demo", title: "Batch C", status: "triage" });
      const project = getProject(db, "demo");
      if (!project) throw new Error("missing fixture project");
      const actions = createPiRunnerActions(db, {
        bus,
        conversationID: "feishu-chat-oc_group-20260614",
        project,
        source: "feishu_runner_chat"
      });

      const result = actions.enqueueBatchTriageIssues({ user_phrase: "把剩下的 issue 都开始" }) as {
        enqueued_count: number;
        status: string;
      };

      expect(result).toMatchObject({ enqueued_count: 3, status: "completed" });
      expect(listSyncOutbox(db, { source: "feishu" })).toHaveLength(0);

      updateIssue(db, first.id, { error: "", status: "in_progress" });
      bus.publish({ issueId: first.id, payload: JSON.stringify({ status: "in_progress" }), projectId: "demo", type: "issue.status_changed" });

      expect(listSyncOutbox(db, { source: "feishu" })).toHaveLength(0);
    } finally {
      detach();
      db.close();
    }
  });

  test("observer still sends start notifications for approved non-runner-chat enqueue actions", async () => {
    const db = await fixtureDatabase();
    const bus = new EventBus();
    const detach = attachFeishuNotificationObservers({ bus, database: db });
    try {
      const issueID = linkedFeishuIssue(db);
      updateIssue(db, issueID, { status: "todo", error: "" });
      createPiAction(db, {
        action_type: "issue.enqueue",
        gate_decision: "ask",
        id: "manual-approved-enqueue",
        issue_id: issueID,
        project_id: "demo",
        source: "pi_tool",
        status: "completed"
      });

      bus.publish({
        conversationId: "feishu-chat-oc_group-20260614",
        issueId: issueID,
        payload: JSON.stringify({ action_id: "manual-approved-enqueue", action_type: "issue.enqueue", status: "completed" }),
        projectId: "demo",
        type: "pi.action_completed"
      });

      const outbox = listSyncOutbox(db, { source: "feishu" });
      expect(outbox).toHaveLength(1);
      expect(outbox[0]?.content).toContain("准备启动");
    } finally {
      detach();
      db.close();
    }
  });

  test("observer queues memory candidate notifications", async () => {
    const db = await fixtureDatabase();
    const bus = new EventBus();
    const detach = attachFeishuNotificationObservers({ bus, database: db });
    try {
      createCandidate(db, "22345678-2222-4222-8222-123456789abc", "通知使用短句");

      bus.publish(memoryCandidateEvent("22345678-2222-4222-8222-123456789abc"));

      const outbox = listSyncOutbox(db, { source: "feishu" });
      expect(outbox).toHaveLength(1);
      expect(outbox[0]).toMatchObject({ target_chat_id: "oc_group" });
      expect(outbox[0]?.content).toContain("/memory approve 22345678");
    } finally {
      detach();
      db.close();
    }
  });

  test("project loop claim and failure events queue start and failed notifications", async () => {
    const db = await fixtureDatabase("fake-execution-only");
    const bus = new EventBus();
    const detach = attachFeishuNotificationObservers({ bus, database: db });
    try {
      linkedFeishuIssue(db);
      updateIssue(db, 1, { error: "", status: "todo" });

      const result = await runProjectLoopOnce({
        bus,
        database: db,
        projectId: "demo",
        providers: { "fake-execution-only": failingProvider() }
      });

      const outbox = listSyncOutbox(db, { source: "feishu" });
      expect(result).toMatchObject({ claimed: true });
      expect(outbox).toHaveLength(2);
      expect(outbox.map((item) => item.content).join("\n")).toContain("已启动 executor session");
      expect(outbox.map((item) => item.content).join("\n")).toContain("执行失败/阻塞");
    } finally {
      detach();
      db.close();
    }
  });

  test("observer queues one PI action pending approval notification", async () => {
    const db = await fixtureDatabase();
    const bus = new EventBus();
    const detach = attachFeishuNotificationObservers({ bus, database: db });
    try {
      const issueID = linkedFeishuIssue(db, { conversationID: "feishu-chat-oc_group-20260614" });
      const event = {
        conversationId: "feishu-chat-oc_group-20260614",
        issueId: issueID,
        payload: JSON.stringify({ action_id: "pi-action-1", action_type: "session.steer", status: "pending" }),
        projectId: "demo",
        type: "pi.action_pending"
      };

      bus.publish(event);
      bus.publish(event);

      const outbox = listSyncOutbox(db, { source: "feishu" });
      expect(outbox).toHaveLength(1);
      expect(outbox[0]).toMatchObject({ target_chat_id: "oc_group" });
      expect(outbox[0]?.content).toContain("需要用户确认");
      expect(outbox[0]?.content).toContain("pi-action-1");
    } finally {
      detach();
      db.close();
    }
  });
});

async function fixtureDatabase(provider = "codex"): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-feishu-lifecycle-"));
  tempRoots.push(root);
  const db = await openDatabase({ stateDir: join(root, "state") });
  db.sqlite.run(
    `insert into projects (id, name, cwd, provider, provider_config_json, sort_order, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?)`,
    ["demo", "Demo", join(root, "project"), provider, '{"capabilities":["issue_execution"]}', 1,
      "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
  return db;
}

function failingProvider(): ExecutorProvider {
  return {
    id: "fake-execution-only",
    capabilities: ["issue_execution"],
    async run(input: ProviderRunInput) {
      input.onEvent?.({
        provider: "fake-execution-only",
        session: { provider: "fake-execution-only", sessionId: "thread-fail", turnId: "turn-fail" },
        status: "running",
        type: "provider.message"
      });
      throw new Error("provider failed");
    }
  };
}

function linkedFeishuIssue(db: RunnerDatabase, input: { conversationID?: string } = {}): number {
  const issue = createIssue(db, { project_id: "demo", title: "Feishu task", status: "triage" });
  const event = createExternalEvent(db, {
    content: "帮我修复问题",
    dedupe_key: "feishu:message:om_task",
    external_id: "om_task",
    normalized_message: { chat_id: "oc_group", message_id: "om_task" },
    source: "feishu"
  });
  createExternalLink(db, {
    conversation_id: input.conversationID ?? "oc_group",
    external_event_id: event.id,
    external_type: "feishu_message",
    issue_id: issue.id,
    project_id: "demo",
    relationship: "created_issue",
    source: "feishu"
  });
  return issue.id;
}

function createCandidate(db: RunnerDatabase, id: string, content: string): void {
  createPiMemoryItem(db, {
    id,
    scope: "project",
    scope_id: "demo",
    kind: "user_preference",
    content,
    source_type: "pi.conversation",
    source_id: "feishu-chat-oc_group-20260614",
    disabled: 1
  });
}

function memoryCandidateEvent(id: string) {
  return {
    conversationId: "feishu-chat-oc_group-20260614",
    payload: JSON.stringify({ id, kind: "user_preference", scope: "project", scope_id: "demo" }),
    projectId: "demo",
    type: "pi.memory_candidate"
  };
}
