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
      expect(context).toContain("pi_memory_items/project-policy");
      expect(context).toContain("source=runbook:policy-doc");
      expect(context).toContain("updated=2026-01-01T00:00:00Z");
      expect(context).toContain("memory_write_candidate");
    } finally {
      db.close();
    }
  });

  test("orders scoped memories with a bounded limit and traceable references", async () => {
    const db = await openFixtureDatabase();
    try {
      insertMemory(db, {
        content: "Global fallback",
        id: "global",
        kind: "decision",
        scope: "global",
        scopeID: "runner"
      });
      insertMemory(db, {
        content: "Project scoped policy",
        id: "project",
        kind: "project_policy",
        pinned: 1,
        scope: "project",
        scopeID: "demo"
      });
      insertMemory(db, {
        content: "Issue-specific acceptance",
        id: "issue",
        kind: "issue_memory",
        scope: "issue",
        scopeID: "259"
      });

      const context = buildPiMemoryPromptContext(db, { issueID: 259, limit: 2, projectID: "demo" });

      expect(context).toContain("Issue-specific acceptance");
      expect(context).toContain("Project scoped policy");
      expect(context).not.toContain("Global fallback");
      expect(context.indexOf("pi_memory_items/issue")).toBeLessThan(context.indexOf("pi_memory_items/project"));
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
      (id, scope, scope_id, kind, content, source_type, source_id, confidence, pinned, disabled, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [item.id, item.scope, item.scopeID, item.kind, item.content, "runbook", "policy-doc", "high", item.pinned ?? 0, item.disabled ?? 0,
      "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
}
