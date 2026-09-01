import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { getPiAction, listPiActionEvents, listPiActions } from "../db/repositories/pi.ts";
import { createDefaultRouter } from "./server.ts";

const BASE_URL = "http://127.0.0.1:3008";
const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) await rm(tempRoots.pop() ?? "", { recursive: true, force: true });
});

describe("PI stale pending action maintenance API", () => {
  test("dry-runs and applies stale supervisor and enqueue actions without touching fresh requests", async () => {
    const { db, root } = await openFixture();
    try {
      seedHistoricalStaleSupervisorCase(db);
      const router = createDefaultRouter({ database: db });

      const dryRun = await router.handle(new Request(`${BASE_URL}/api/pi/maintenance/stale-pending-actions`));
      const dryRunBody = await dryRun.json() as Record<string, unknown>;

      expect(dryRun.status).toBe(200);
      expect(dryRunBody).toMatchObject({ applied: false, dry_run: true, matched_count: 75 });
      expect(actionIDs(dryRunBody)).toContain("stale-terminal-001");
      expect(actionIDs(dryRunBody)).toContain("stale-run");
      expect(actionIDs(dryRunBody)).toContain("stale-expired");
      expect(actionIDs(dryRunBody)).toContain("real-enqueue");
      expect(actionIDs(dryRunBody)).toContain("superseded-enqueue");
      expect(actionIDs(dryRunBody)).not.toContain("fresh-enqueue");
      expect(actionReasons(dryRunBody, "real-enqueue")).toContain("target_state_changed:done");
      expect(actionReasons(dryRunBody, "superseded-enqueue")).toContain("superseded_by:completed-enqueue");
      expect(actionReasons(dryRunBody, "stale-terminal-001")).toContain("terminal_issue:done");
      expect(actionReasons(dryRunBody, "stale-run")).toContain("terminal_run:done");
      expect(listPiActions(db, { status: "pending" }).map((action) => action.id).sort()).toEqual([
        "fresh-enqueue",
        "fresh-supervisor",
        "real-enqueue",
        "stale-expired",
        "stale-run",
        ...Array.from({ length: 71 }, (_, index) => `stale-terminal-${String(index + 1).padStart(3, "0")}`),
        "superseded-enqueue"
      ]);

      const applyUrl = `${BASE_URL}/api/pi/maintenance/stale-pending-actions/apply`;
      const missingConfirm = await router.handle(new Request(applyUrl, {
        body: JSON.stringify({ confirm: false }),
        method: "POST"
      }));
      expect(missingConfirm.status).toBe(400);

      const applied = await router.handle(new Request(applyUrl, {
        body: JSON.stringify({ backup_dir: join(root, "backups"), confirm: true }),
        method: "POST"
      }));
      const appliedBody = await applied.json() as Record<string, unknown>;

      expect(applied.status).toBe(200);
      expect(appliedBody).toMatchObject({ applied: true, dry_run: false, matched_count: 75 });
      expect(existsSync(String(appliedBody.backup_path))).toBe(true);
      expect(getPiAction(db, "stale-terminal-001")).toMatchObject({ status: "rejected", decided_by: "maintenance" });
      expect(getPiAction(db, "stale-expired")).toMatchObject({ status: "rejected", decided_by: "maintenance" });
      expect(getPiAction(db, "real-enqueue")).toMatchObject({ status: "rejected", decided_by: "maintenance" });
      expect(getPiAction(db, "fresh-enqueue")).toMatchObject({ status: "pending" });
      expect(getPiAction(db, "superseded-enqueue")).toMatchObject({ status: "rejected", decided_by: "maintenance" });
      expect(getPiAction(db, "fresh-supervisor")).toMatchObject({ status: "pending" });
      expect(listPiActionEvents(db).filter((event) => event.event_type === "maintenance_stale_cleanup"))
        .toHaveLength(75);
    } finally {
      db.close();
    }
  });
});

async function openFixture(): Promise<{ db: RunnerDatabase; root: string }> {
  const root = await mkdtemp(join(tmpdir(), "xuanwu-pi-maintenance-"));
  tempRoots.push(root);
  return { db: await openDatabase({ stateDir: join(root, "state") }), root };
}

function seedHistoricalStaleSupervisorCase(db: RunnerDatabase): void {
  insertProject(db, "demo");
  for (let index = 1; index <= 71; index += 1) {
    const issueID = 1000 + index;
    insertIssue(db, issueID, "done");
    insertPiAction(db, {
      actionType: "needs_user.escalate",
      id: `stale-terminal-${String(index).padStart(3, "0")}`,
      issueID,
      source: "pi_supervisor"
    });
  }
  insertIssue(db, 386, "done");
  insertIssue(db, 387, "triage");
  insertIssue(db, 388, "triage");
  insertIssue(db, 389, "triage");
  insertIssue(db, 390, "todo");
  insertRun(db, 388, "done");
  insertPiAction(db, { actionType: "issue.enqueue", id: "real-enqueue", issueID: 386, source: "runner_chat" });
  insertPiAction(db, { actionType: "issue.enqueue", id: "fresh-enqueue", issueID: 389, source: "runner_chat" });
  insertPiAction(db, {
    actionType: "issue.enqueue",
    createdAt: "2026-01-01T00:00:00Z",
    id: "superseded-enqueue",
    issueID: 390,
    source: "runner_chat"
  });
  insertPiAction(db, {
    actionType: "issue.enqueue",
    createdAt: "2026-01-02T00:00:00Z",
    id: "completed-enqueue",
    issueID: 390,
    source: "runner_chat",
    status: "completed"
  });
  insertPiAction(db, {
    actionType: "needs_user.escalate",
    id: "fresh-supervisor",
    issueID: 387,
    source: "pi_supervisor"
  });
  insertPiAction(db, {
    actionType: "issue.supervisor_decision",
    id: "stale-run",
    issueID: 388,
    source: "pi_supervisor"
  });
  insertPiAction(db, {
    actionType: "legacy.supervisor_wait",
    id: "stale-expired",
    issueID: 387,
    payload: { expires_at: "2026-01-01T00:00:00Z" },
    source: "pi_supervisor"
  });
}

function insertProject(db: RunnerDatabase, id: string): void {
  db.sqlite.run(`insert into projects (id, name, cwd, created_at, updated_at) values (?, ?, ?, ?, ?)`, [
    id, id, `/tmp/${id}`, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"
  ]);
}

function insertIssue(db: RunnerDatabase, id: number, status: string): void {
  db.sqlite.run(
    `insert into issues (id, project_id, title, status, created_at, updated_at)
     values (?, 'demo', ?, ?, ?, ?)`,
    [id, `Issue ${id}`, status, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
}

function insertRun(db: RunnerDatabase, issueID: number, status: string): void {
  db.sqlite.run(
    `insert into issue_runs (id, issue_id, attempt, status, started_at, ended_at)
     values (?, ?, 1, ?, ?, ?)`,
    [`issue-${issueID}-attempt-1`, issueID, status, "2026-01-01T00:00:00Z", "2026-01-01T01:00:00Z"]
  );
}

type PiActionFixture = {
  actionType: string;
  createdAt?: string;
  id: string;
  issueID: number;
  payload?: Record<string, unknown>;
  source: string;
  status?: string;
};

function insertPiAction(db: RunnerDatabase, input: PiActionFixture): void {
  db.sqlite.run(
    `insert into pi_actions
      (id, project_id, issue_id, action_type, status, source, gate_decision,
       payload_json, created_at, updated_at)
     values (?, 'demo', ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.id, input.issueID, input.actionType, input.status ?? "pending", input.source,
      input.status === "completed" ? "execute" : "ask",
      JSON.stringify(input.payload ?? { issue_id: input.issueID }),
      input.createdAt ?? "2026-01-01T00:00:00Z", input.createdAt ?? "2026-01-01T00:00:00Z"
    ]
  );
}

function actionIDs(body: Record<string, unknown>): string[] {
  return actions(body).map((action) => String(action.action_id));
}

function actionReasons(body: Record<string, unknown>, id: string): string {
  return String(actions(body).find((action) => action.action_id === id)?.reason ?? "");
}

function actions(body: Record<string, unknown>): Array<Record<string, unknown>> {
  return Array.isArray(body.actions) ? body.actions as Array<Record<string, unknown>> : [];
}
