import { afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../../db/database.ts";
import { createContextBundle } from "../../db/repositories/contextBundles.ts";
import { createAttentionInboxItem, createIntakeRun } from "../../db/repositories/intakeRuns.ts";
import type { HandoffRecord } from "../../domain/handoff/contracts.ts";
import { issueIDToWorkID } from "../../domain/work/issueAdapter.ts";
import { makeDomainID } from "../../xuanwu/coreDomainContracts.ts";
import { useDatabaseCleanup } from "../../testing/harness.ts";



export function createTestFixture() {
  const trackDatabase = useDatabaseCleanup();

  const BASE_URL = "http://127.0.0.1:3008";

  const NOW = "2026-07-17T08:01:00.000Z";

  const SOURCE_TIME = "2026-07-17T08:00:00.000Z";

  const tempRoots: string[] = [];

  afterEach(async () => {
    while (tempRoots.length > 0) {
      const path = tempRoots.pop();
      if (path) await rm(path, { force: true, recursive: true });
    }
  });

  async function fixtureDatabase(): Promise<RunnerDatabase> {
    const root = await mkdtemp(join(tmpdir(), "xuanwu-command-center-"));
    tempRoots.push(root);
    const db = await openDatabase({ stateDir: join(root, "state") }).then(trackDatabase);
    db.sqlite.run(`
    insert into projects (id, name, cwd, provider, created_at, updated_at)
    values ('demo', 'Demo', '/tmp/command-center-demo', 'codex', ?, ?)
  `, [SOURCE_TIME, SOURCE_TIME]);
    return db;
  }

  function insertRun(db: RunnerDatabase, issueID: number): string {
    db.sqlite.run(`
    insert into issue_runs (id, issue_id, attempt, status, provider, started_at)
    values (?, ?, 1, 'in_progress', 'codex', ?)
  `, [`command-center-run-${issueID}`, issueID, SOURCE_TIME]);
    return makeDomainID("run", "issue_runs", `command-center-run-${issueID}`);
  }

  function insertAttention(db: RunnerDatabase): number {
    const bundle = createContextBundle(db, {
      created_by: "system",
      event_refs: [1],
      reason: "command-center-test",
      source: "fixture",
      trigger: "manual",
      window: { from: SOURCE_TIME, to: SOURCE_TIME }
    }, new Date(SOURCE_TIME));
    const run = createIntakeRun(db, {
      bundle_id: bundle.id,
      skill_id: "fixture-intake",
      status: "succeeded"
    }, new Date(SOURCE_TIME));
    return createAttentionInboxItem(db, {
      bundle_id: bundle.id,
      confidence: 0.9,
      evidence_refs: ["external_event:1"],
      intake_run_id: run.id,
      primary_intent: "approval",
      source: "fixture",
      status: "new",
      suggested_actions: ["review"],
      summary: "Review the pending action",
      title: "Approval needed",
      urgency: "high"
    }, new Date(SOURCE_TIME)).id;
  }

  function attentionCommand(revision: number, action: "acknowledge" | "snooze"): Record<string, unknown> {
    return {
      audit: {
        actor: { id: "user:fixture", kind: "user" },
        correlation_id: "command-center:fixture",
        event_id: `attention-${action}-${revision}`,
        gate: { authority: "human_approval", decision: "allow", policy_ref: "command-center:test" },
        occurred_at: NOW,
        reason: `Fixture Attention ${action}`
      },
      expected_revision: revision,
      ...(action === "snooze" ? { snoozed_until: "2026-07-17T09:00:00.000Z" } : {})
    };
  }

  function jsonRequest(path: string, body: Record<string, unknown>): Request {
    return new Request(`${BASE_URL}${path}`, {
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
      method: "POST"
    });
  }

  function handoff(issueID: number): HandoffRecord {
    return {
      baseline_revision: "git:base",
      changed_files: ["backend-ts/src/http/work/commandCenterApi.ts"],
      created_at: SOURCE_TIME,
      delivery: { mode: "local_changes", working_tree_ref: "git:tree-command-center" },
      delivery_actions: [],
      evidence_ids: [],
      final_revision: "git:tree-command-center",
      id: makeDomainID("handoff", "derived", `command-center-${issueID}`),
      review: { required: false, reviewer_refs: [], state: "not_requested" },
      review_ref: "git:tree-command-center",
      revision: 0,
      risks: [],
      rollback: { availability: "not_required", destructive: false, refs: [] },
      run_ids: [],
      schema_version: 1,
      status: "draft",
      summary: "Command Center aggregate delivery",
      updated_at: SOURCE_TIME,
      work_id: issueIDToWorkID(issueID)
    };
  }
  return { trackDatabase, BASE_URL, NOW, SOURCE_TIME, tempRoots, fixtureDatabase, insertRun, insertAttention, attentionCommand, jsonRequest, handoff };
}
export type TestFixture = ReturnType<typeof createTestFixture>;
