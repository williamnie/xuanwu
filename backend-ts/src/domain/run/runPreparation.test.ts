import { createHash } from "node:crypto";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../../db/database.ts";
import { createIssue } from "../../db/repositories/issueCreate.ts";
import {
  finalizeIssueRunPreparation,
  insertIssueRunRecord
} from "../../db/repositories/issueRuns.ts";
import { ISSUE_RUN_GIT_WORKSPACE_BASELINE_EVENT } from "../evidence/runGitWorkspaceBaseline.ts";
import { prepareReservedIssueRun } from "./runPreparation.ts";

const roots: string[] = [];
afterEach(async () => {
  while (roots.length > 0) await rm(roots.pop()!, { recursive: true, force: true });
});

describe("two-phase Run preparation", () => {
  test("keeps Git observation outside the writer transaction and finalizes a captured baseline once", async () => {
    const db = await fixture();
    try {
      const issue = createIssue(db, { project_id: "demo", status: "in_progress", title: "Prepare" });
      const reservation = db.transaction(() => insertIssueRunRecord(db, issue.id)).immediate();
      let release!: () => void;
      const observation = new Promise<void>((resolve) => { release = resolve; });
      const baseline = capturedBaseline();
      const pending = prepareReservedIssueRun(db, reservation, async () => {
        await observation;
        return baseline;
      });
      await Promise.resolve();

      const started = performance.now();
      db.sqlite.run("update issues set title='Writer stayed live' where id=?", [issue.id]);
      expect(performance.now() - started).toBeLessThan(100);
      release();
      const prepared = await pending;

      expect(prepared).toMatchObject({ baseline_recorded: true, status: "ready" });
      if (prepared.status !== "ready") throw new Error("preparation failed");
      expect(prepared.run.git_base_revision).toBe(baseline.base_revision);
      expect(eventCount(db, issue.id)).toBe(1);
      expect(finalizeIssueRunPreparation(db, reservation, baseline).status).toBe("claim_invalidated");
      expect(eventCount(db, issue.id)).toBe(1);
    } finally { db.close(); }
  });

  test("allows a missing baseline only while the reservation remains the canonical current Run", async () => {
    const db = await fixture();
    try {
      const issue = createIssue(db, { project_id: "demo", status: "in_progress", title: "Unavailable" });
      const reservation = insertIssueRunRecord(db, issue.id);
      const ready = await prepareReservedIssueRun(db, reservation, async () => null);
      expect(ready).toMatchObject({ baseline_recorded: false, status: "ready" });
      expect(eventCount(db, issue.id)).toBe(0);

      db.sqlite.run("update issues set status='cancelled' where id=?", [issue.id]);
      expect(finalizeIssueRunPreparation(db, reservation, null).status).toBe("claim_invalidated");
    } finally { db.close(); }
  });
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "xuanwu-run-preparation-"));
  roots.push(root);
  const db = await openDatabase({ stateDir: join(root, "state") });
  db.sqlite.run(
    "insert into projects (id, name, cwd, created_at, updated_at) values (?, ?, ?, ?, ?)",
    ["demo", "demo", root, "2026-08-19T00:00:00Z", "2026-08-19T00:00:00Z"]
  );
  return db;
}

function capturedBaseline() {
  return {
    base_revision: "a".repeat(40),
    captured_at: "2026-08-19T00:00:00.000Z",
    entries: [],
    snapshot_sha256: createHash("sha256").update("[]\n").digest("hex")
  };
}
function eventCount(db: Awaited<ReturnType<typeof fixture>>, issueID: number): number {
  return Number(db.sqlite.query<{ count: number }, [number, string]>(
    "select count(*) as count from issue_events where issue_id=? and type=?"
  ).get(issueID, ISSUE_RUN_GIT_WORKSPACE_BASELINE_EVENT)?.count ?? 0);
}
