import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import type { FeishuNormalizedMessageEvent } from "./feishu.ts";
import { routeFeishuConversation } from "./feishuConversationRouting.ts";

const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) await rm(root, { recursive: true, force: true });
  }
});

describe("Feishu conversation routing", () => {
  test("reuses one stable conversation for ordinary chat messages", async () => {
    const db = await openFixtureDatabase();
    try {
      const first = routeFeishuConversation(db, {
        clock: fixedClock("2026-06-13T01:02:03Z"),
        event: eventFixture({ message_id: "om_1" }),
        prompt: "hi"
      });
      const second = routeFeishuConversation(db, {
        clock: fixedClock("2026-06-13T22:00:00Z"),
        event: eventFixture({ message_id: "om_2" }),
        prompt: "next"
      });

      expect(first.conversationId).toBe("feishu-chat-oc_group");
      expect(second.conversationId).toBe("feishu-chat-oc_group");
      expect(first.prompt).toBe("hi");
      expect(second.prompt).toBe("next");
    } finally {
      db.close();
    }
  });

  test("keeps the stable conversation when an ordinary chat crosses days", async () => {
    const db = await openFixtureDatabase();
    try {
      const today = routeFeishuConversation(db, {
        clock: fixedClock("2026-06-13T23:59:00Z"),
        event: eventFixture({ message_id: "om_today" }),
        prompt: "today"
      });
      const tomorrow = routeFeishuConversation(db, {
        clock: fixedClock("2026-06-14T00:01:00Z"),
        event: eventFixture({ message_id: "om_tomorrow" }),
        prompt: "tomorrow"
      });

      expect(today.conversationId).toBe("feishu-chat-oc_group");
      expect(tomorrow.conversationId).toBe("feishu-chat-oc_group");
    } finally {
      db.close();
    }
  });

  test("prioritizes stable thread and root ids over chat routing", async () => {
    const db = await openFixtureDatabase();
    try {
      const threaded = routeFeishuConversation(db, {
        clock: fixedClock("2026-06-13T01:02:03Z"),
        event: eventFixture({ message_id: "om_thread", thread_id: "omt_thread" }),
        prompt: "thread"
      });
      const rooted = routeFeishuConversation(db, {
        clock: fixedClock("2026-06-14T01:02:03Z"),
        event: eventFixture({ message_id: "om_root", root_id: "om_root_parent" }),
        prompt: "root"
      });

      expect(threaded.conversationId).toBe("feishu-thread-omt_thread");
      expect(rooted.conversationId).toBe("feishu-thread-om_root_parent");
    } finally {
      db.close();
    }
  });

  test("sanitizes Feishu ids while keeping stable route prefixes", async () => {
    const db = await openFixtureDatabase();
    try {
      const route = routeFeishuConversation(db, {
        clock: fixedClock("2026-06-13T01:02:03Z"),
        event: eventFixture({ chat_id: "oc.group:1/2", message_id: "om:1/2" }),
        prompt: "sanitize"
      });

      expect(route.scopeKey).toBe("feishu-chat-oc-group-1-2");
      expect(route.conversationId).toBe("feishu-chat-oc-group-1-2");
    } finally {
      db.close();
    }
  });

  test("/new starts a new epoch and strips the command prompt", async () => {
    const db = await openFixtureDatabase();
    try {
      const reset = routeFeishuConversation(db, {
        clock: fixedClock("2026-06-13T01:02:03Z"),
        event: eventFixture({ message_id: "om_new" }),
        prompt: "/new 继续新的上下文"
      });
      const next = routeFeishuConversation(db, {
        clock: fixedClock("2026-06-13T02:00:00Z"),
        event: eventFixture({ message_id: "om_after_new" }),
        prompt: "下一句"
      });
      const secondReset = routeFeishuConversation(db, {
        clock: fixedClock("2026-06-13T03:00:00Z"),
        event: eventFixture({ message_id: "om_new_2" }),
        prompt: "/new"
      });

      expect(reset).toMatchObject({
        conversationId: "feishu-chat-oc_group-n1",
        epoch: 1,
        isNewCommand: true,
        prompt: "继续新的上下文"
      });
      expect(next.conversationId).toBe("feishu-chat-oc_group-n1");
      expect(next.prompt).toBe("下一句");
      expect(secondReset).toMatchObject({
        conversationId: "feishu-chat-oc_group-n2",
        epoch: 2,
        isNewCommand: true,
        prompt: ""
      });
    } finally {
      db.close();
    }
  });

  test("adopts the newest legacy daily conversation without losing its reset epoch", async () => {
    const db = await openFixtureDatabase();
    try {
      insertConversation(db, "feishu-chat-oc_group-20260720-n2", "2026-07-20T09:00:00.000Z");
      db.sqlite.run(
        `insert into feishu_conversation_state
           (scope_key, active_conversation_id, active_project_id, active_project_source,
            epoch, started_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?)`,
        [
          "feishu-chat-oc_group-20260720",
          "feishu-chat-oc_group-20260720-n2",
          "demo",
          "card_select",
          2,
          "2026-07-20T09:00:00.000Z",
          "2026-07-20T09:00:00.000Z"
        ]
      );

      const reset = routeFeishuConversation(db, {
        clock: fixedClock("2026-07-21T01:01:00Z"),
        event: eventFixture({ message_id: "om_reset_upgrade" }),
        prompt: "/new"
      });

      expect(reset.conversationId).toBe("feishu-chat-oc_group-n3");
    } finally {
      db.close();
    }
  });

  test("falls back to message scoped conversations when chat id is missing", async () => {
    const db = await openFixtureDatabase();
    try {
      const route = routeFeishuConversation(db, {
        clock: fixedClock("2026-06-13T01:02:03Z"),
        event: eventFixture({ chat_id: "", message_id: "om_message_only" }),
        prompt: "message scope"
      });

      expect(route.scopeKey).toBe("feishu-message-om_message_only");
      expect(route.conversationId).toBe("feishu-message-om_message_only");
    } finally {
      db.close();
    }
  });
});

async function openFixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "xuanwu-feishu-route-"));
  tempRoots.push(root);
  return openDatabase({ stateDir: join(root, "state") });
}

function fixedClock(localIso: string) {
  return { now: () => localDate(localIso) };
}

function localDate(localIso: string): Date {
  const match = localIso.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/);
  if (!match) throw new Error(`invalid fixture date: ${localIso}`);
  return new Date(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6])
  );
}

function eventFixture(
  overrides: Partial<FeishuNormalizedMessageEvent> = {}
): FeishuNormalizedMessageEvent {
  return {
    attachments: [],
    chat_id: "oc_group",
    chat_type: "group",
    dedupe_key: `feishu:message:${overrides.message_id ?? "om_default"}`,
    mentions: [],
    message_id: "om_default",
    raw_event_ref: "",
    root_id: "",
    sender: { id: "ou_user", open_id: "ou_open", tenant_key: "tenant", type: "user" },
    source_id: `feishu:message:${overrides.message_id ?? "om_default"}`,
    text: "hello",
    thread_id: "",
    timestamp: "2026-06-13T00:00:00.000Z",
    ...overrides
  };
}

function insertConversation(db: RunnerDatabase, id: string, timestamp: string): void {
  db.sqlite.run(
    `insert into pi_conversations
       (id, project_id, pi_agent_id, title, status, session_file, pi_session_id, created_at, updated_at)
     values (?, '', 'default', '', 'active', '', '', ?, ?)`,
    [id, timestamp, timestamp]
  );
}
