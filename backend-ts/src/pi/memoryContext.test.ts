import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { buildPiMemoryPromptContext } from "./memoryContext.ts";

const tempRoots: string[] = [];

async function openFixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-bun-pi-memory-context-"));
  tempRoots.push(root);
  return openDatabase({ stateDir: join(root, "state") });
}

afterEach(async () => {
  while (tempRoots.length > 0) {
    const path = tempRoots.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

describe("PI memory prompt context", () => {
  test("loads confirmed project/global memories and omits disabled candidates", async () => {
    const db = await openFixtureDatabase();
    try {
      insertMemory(db, {
        content: "User prefers concise Chinese status updates",
        id: "global-pref",
        kind: "user_preference",
        scope: "global",
        scopeID: "runner"
      });
      insertMemory(db, {
        content: "Project policy: verify before commit",
        id: "project-policy",
        kind: "project_policy",
        pinned: 1,
        scope: "project",
        scopeID: "demo"
      });
      insertMemory(db, {
        content: "Unconfirmed guess should stay hidden",
        disabled: 1,
        id: "candidate",
        kind: "decision",
        scope: "project",
        scopeID: "demo"
      });

      const context = buildPiMemoryPromptContext(db, { projectID: "demo" });

      expect(context).toContain("Confirmed PI memory");
      expect(context).toContain("Project policy: verify before commit");
      expect(context).toContain("User prefers concise Chinese status updates");
      expect(context).not.toContain("Unconfirmed guess");
      expect(context).toContain("memory_write_candidate");
    } finally {
      db.close();
    }
  });
});

function insertMemory(db: RunnerDatabase, item: {
  content: string; disabled?: number; id: string; kind: string; pinned?: number; scope: string; scopeID: string;
}): void {
  db.sqlite.run(
    `insert into pi_memory_items
      (id, scope, scope_id, kind, content, confidence, pinned, disabled, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [item.id, item.scope, item.scopeID, item.kind, item.content, "high", item.pinned ?? 0, item.disabled ?? 0,
      "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
}
