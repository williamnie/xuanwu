import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../database.ts";
import { createPiMemoryItem } from "../repositories/pi/memoryItems.ts";
import { piContextMemoryAuthorityMigration } from "./066_pi_context_memory_authority.ts";

const roots: string[] = [];

afterEach(async () => {
  while (roots.length > 0) await rm(roots.pop()!, { recursive: true, force: true });
});

describe("PI context memory authority migration", () => {
  test("backfills explicit conversation policy and evidence-backed manager experience", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-memory-authority-"));
    roots.push(root);
    const db = await openDatabase({ stateDir: join(root, "state") });
    try {
      createPiMemoryItem(db, {
        id: "legacy-user-policy",
        kind: "project_preference",
        content: "缺少真实 Provider 配置时不要阻塞离线实现",
        scope: "project",
        scope_id: "demo",
        source_type: "pi.conversation",
        source_id: "feishu-chat-demo"
      });
      createPiMemoryItem(db, {
        id: "legacy-resolution",
        kind: "resolution",
        content: "恢复前读取 canonical Run",
        scope: "project",
        scope_id: "demo",
        source_type: "pi.manager_cycle",
        source_id: "manager-demo",
        citation_type: "handoff",
        citation_id: "issue-841"
      });

      piContextMemoryAuthorityMigration.apply!(db.sqlite);

      expect(db.sqlite.query(
        "select authority, authorized_by from pi_memory_items where id='legacy-user-policy'"
      ).get()).toEqual({ authority: "user_explicit", authorized_by: "feishu-chat-demo" });
      expect(db.sqlite.query(
        "select authority, authorized_by from pi_memory_items where id='legacy-resolution'"
      ).get()).toEqual({ authority: "evidence_backed", authorized_by: "handoff:issue-841" });
    } finally {
      db.close();
    }
  });
});
