import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../database.ts";
import { backfillImProjectSelections } from "../schema/071_im_interaction_bindings.ts";
import {
  consumeImInteractionBinding,
  createImInteractionBinding,
  getImInteractionBinding,
  newImInteractionToken
} from "./imInteractionBindings.ts";
import {
  consumeImProjectSelection,
  createImProjectSelection,
  getImProjectSelection
} from "./imProjectSelections.ts";
import {
  consumeFeishuPendingProjectSelection,
  createFeishuPendingProjectSelection,
  getFeishuPendingProjectSelection
} from "./feishuProjectSelection.ts";

const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) await rm(root, { recursive: true, force: true });
  }
});

describe("IM interaction bindings", () => {
  test("tokens carry at least 128 bit entropy and bindings persist opaque refs", async () => {
    const db = await openFixtureDatabase();
    try {
      const token = newImInteractionToken();
      expect(token).toMatch(/^[A-Za-z0-9_-]{22}$/);
      expect(newImInteractionToken()).not.toBe(token);
      const binding = createImInteractionBinding(db, {
        actionKind: "pi_action",
        actionRef: "pi_actions:act-1",
        actions: [{ action_id: "approve", value: "approve" }],
        actor: { id: "u_1", openId: "ou_1" },
        connectorId: "feishu",
        expiresAt: "2026-08-08T00:00:00.000Z",
        interactionId: token,
        scopeKey: "feishu-chat-oc_1"
      }, new Date("2026-08-07T00:00:00.000Z"));
      expect(binding).toMatchObject({
        action_kind: "pi_action",
        action_ref: "pi_actions:act-1",
        actions: [{ action_id: "approve", value: "approve" }],
        actor_id: "u_1",
        connector_id: "feishu",
        interaction_id: token,
        revision: 1,
        status: "pending"
      });
      expect(getImInteractionBinding(db, token)?.action_ref).toBe("pi_actions:act-1");
    } finally {
      db.close();
    }
  });

  test("consume is once-only and gated by connector, scope and expiry", async () => {
    const db = await openFixtureDatabase();
    try {
      const binding = createImInteractionBinding(db, {
        actionKind: "approval",
        actionRef: "pi_approval_requests:apr-1",
        actions: [{ action_id: "approve", value: "approve" }],
        actor: { id: "u_1", openId: "ou_1" },
        connectorId: "feishu",
        expiresAt: "2026-08-08T00:00:00.000Z",
        scopeKey: "feishu-chat-oc_1"
      }, new Date("2026-08-07T00:00:00.000Z"));
      const now = new Date("2026-08-07T12:00:00.000Z");

      expect(consumeImInteractionBinding(db, {
        actionId: "approve", actor: { id: "u_1", openId: "ou_1" }, revision: 1,
        connectorId: "telegram",
        interactionId: binding.interaction_id,
        now,
        scopeKey: "feishu-chat-oc_1"
      }).status).toBe("source_mismatch");
      expect(consumeImInteractionBinding(db, {
        actionId: "approve", actor: { id: "u_1", openId: "ou_1" }, revision: 1,
        connectorId: "feishu",
        interactionId: binding.interaction_id,
        now,
        scopeKey: "feishu-chat-oc_other"
      }).status).toBe("source_mismatch");

      const consumed = consumeImInteractionBinding(db, {
        actionId: "approve", actor: { id: "u_1", openId: "ou_1" }, revision: 1,
        connectorId: "feishu",
        interactionId: binding.interaction_id,
        now,
        scopeKey: "feishu-chat-oc_1"
      });
      expect(consumed.status).toBe("consumed");
      expect(consumed.binding?.consumed_at).toBe(now.toISOString());

      // Replay / double-click / restart replay: never consumed twice.
      expect(consumeImInteractionBinding(db, {
        actionId: "approve", actor: { id: "u_1", openId: "ou_1" }, revision: 1,
        connectorId: "feishu",
        interactionId: binding.interaction_id,
        now,
        scopeKey: "feishu-chat-oc_1"
      }).status).toBe("already_consumed");
      expect(consumeImInteractionBinding(db, {
        actionId: "approve", actor: { id: "u_1", openId: "ou_1" }, revision: 1,
        connectorId: "feishu",
        interactionId: "i1.does-not-exist",
        now,
        scopeKey: "feishu-chat-oc_1"
      }).status).toBe("missing");

      const expired = createImInteractionBinding(db, {
        actionKind: "approval",
        actionRef: "pi_approval_requests:apr-2",
        actions: [{ action_id: "approve", value: "approve" }],
        actor: { id: "u_1", openId: "ou_1" },
        connectorId: "feishu",
        expiresAt: "2026-08-07T01:00:00.000Z",
        scopeKey: "feishu-chat-oc_1"
      }, new Date("2026-08-07T00:00:00.000Z"));
      expect(consumeImInteractionBinding(db, {
        actionId: "approve", actor: { id: "u_1", openId: "ou_1" }, revision: 1,
        connectorId: "feishu",
        interactionId: expired.interaction_id,
        now,
        scopeKey: "feishu-chat-oc_1"
      }).status).toBe("expired");
    } finally {
      db.close();
    }
  });
});

describe("IM project selections", () => {
  test("creates and consumes one-shot selections per connector", async () => {
    const db = await openFixtureDatabase();
    try {
      const created = createImProjectSelection(db, {
        candidates: ["alpha", "beta"],
        chatId: "oc_1",
        connectorId: "feishu",
        conversationId: "conv-1",
        expiresAt: "2026-08-08T00:00:00.000Z",
        originalPrompt: "fix the bug",
        scopeKey: "feishu-chat-oc_1",
        selectionId: "sel-1",
        sourceMessageId: "om_1",
        userId: "u_1",
        userOpenId: "ou_1"
      }, new Date("2026-08-07T00:00:00.000Z"));
      expect(created.status).toBe("pending");

      const mismatched = consumeImProjectSelection(db, {
        chatId: "oc_1",
        connectorId: "telegram",
        now: new Date("2026-08-07T12:00:00.000Z"),
        projectId: "alpha",
        selectionId: "sel-1",
        userId: "u_1",
        userOpenId: "ou_1"
      });
      expect(mismatched.status).toBe("source_mismatch");

      const invalid = consumeImProjectSelection(db, {
        chatId: "oc_1",
        connectorId: "feishu",
        now: new Date("2026-08-07T12:00:00.000Z"),
        projectId: "gamma",
        selectionId: "sel-1",
        userId: "u_1",
        userOpenId: "ou_1"
      });
      expect(invalid.status).toBe("invalid_project");

      const consumed = consumeImProjectSelection(db, {
        chatId: "oc_1",
        connectorId: "feishu",
        now: new Date("2026-08-07T12:00:00.000Z"),
        projectId: "alpha",
        selectionId: "sel-1",
        userId: "u_1",
        userOpenId: "ou_1"
      });
      expect(consumed.status).toBe("consumed");
      expect(consumed.selection?.selected_project_id).toBe("alpha");
      expect(consumeImProjectSelection(db, {
        chatId: "oc_1",
        connectorId: "feishu",
        now: new Date("2026-08-07T12:00:01.000Z"),
        projectId: "beta",
        selectionId: "sel-1",
        userId: "u_1",
        userOpenId: "ou_1"
      }).status).toBe("already_consumed");
    } finally {
      db.close();
    }
  });

  test("backfill migrates legacy feishu rows idempotently with parity", async () => {
    const db = await openFixtureDatabase();
    try {
      db.sqlite.run(
        `insert into feishu_project_selections
           (selection_id, scope_key, conversation_id, chat_id, user_id, user_open_id,
            source_message_id, original_prompt, candidates_json, status,
            selected_project_id, created_at, expires_at, consumed_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          "legacy-sel-1", "feishu-chat-oc_9", "conv-legacy", "oc_9", "u_9", "ou_9",
          "om_9", "legacy prompt", '["legacy"]', "pending", "",
          "2026-07-01T00:00:00.000Z", "2027-01-01T00:00:00.000Z", ""
        ]
      );
      const first = backfillImProjectSelections(db.sqlite);
      expect(first).toBe(1);
      const migrated = getImProjectSelection(db, "legacy-sel-1");
      expect(migrated).toMatchObject({
        connector_id: "feishu",
        conversation_id: "conv-legacy",
        original_prompt: "legacy prompt",
        scope_key: "feishu-chat-oc_9",
        status: "pending"
      });
      expect(backfillImProjectSelections(db.sqlite)).toBe(0);

      // A legacy row that was consumed before migration stays consumable-proof.
      const consumed = consumeImProjectSelection(db, {
        chatId: "oc_9",
        connectorId: "feishu",
        now: new Date("2026-08-07T00:00:00.000Z"),
        projectId: "legacy",
        selectionId: "legacy-sel-1",
        userId: "u_9",
        userOpenId: "ou_9"
      });
      expect(consumed.status).toBe("consumed");
    } finally {
      db.close();
    }
  });
});

describe("feishu project selection compatibility shim", () => {
  test("legacy repository API reads and writes the neutral table", async () => {
    const db = await openFixtureDatabase();
    try {
      const created = createFeishuPendingProjectSelection(db, {
        candidates: ["alpha"],
        chatId: "oc_2",
        conversationId: "conv-2",
        expiresAt: "2026-08-08T00:00:00.000Z",
        originalPrompt: "do the thing",
        scopeKey: "feishu-chat-oc_2",
        selectionId: "sel-shim-1",
        sourceMessageId: "om_2",
        userId: "u_2",
        userOpenId: "ou_2"
      }, new Date("2026-08-07T00:00:00.000Z"));
      expect(created.status).toBe("pending");
      // Physical write lands in the neutral table, not the legacy carrier.
      expect(getImProjectSelection(db, "sel-shim-1")?.connector_id).toBe("feishu");
      expect(db.sqlite.query<{ count: number }, []>(
        "select count(*) as count from feishu_project_selections where selection_id='sel-shim-1'"
      ).get()?.count).toBe(0);

      const consumed = consumeFeishuPendingProjectSelection(db, {
        chatId: "oc_2",
        now: new Date("2026-08-07T12:00:00.000Z"),
        projectId: "alpha",
        selectionId: "sel-shim-1",
        userId: "u_2",
        userOpenId: "ou_2"
      });
      expect(consumed.status).toBe("consumed");
      expect(getFeishuPendingProjectSelection(db, "sel-shim-1")?.selected_project_id).toBe("alpha");
    } finally {
      db.close();
    }
  });
});

async function openFixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "im-interaction-"));
  tempRoots.push(root);
  return openDatabase({ dbPath: join(root, "runner.db"), stateDir: join(root, "state") });
}
