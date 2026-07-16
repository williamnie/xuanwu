import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { createContextBundle } from "../db/repositories/contextBundles.ts";
import { recordHandoff } from "../db/repositories/handoffs.ts";
import { createAttentionInboxItem, createIntakeRun } from "../db/repositories/intakeRuns.ts";
import { createIssue } from "../db/repositories/issueCreate.ts";
import type { HandoffRecord } from "../domain/handoff/contracts.ts";
import { issueIDToWorkID } from "../domain/work/issueAdapter.ts";
import { makeDomainID } from "../xuanwu/coreDomainContracts.ts";
import {
  commandCenterSectionReaders,
  registerCommandCenterRoutes
} from "./commandCenterApi.ts";
import { createRouter } from "./router.ts";
import { createDefaultRouter } from "./server.ts";

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

describe("Command Center aggregate API", () => {
  test("returns the versioned four-section summary with bounded items, counts, freshness, and links", async () => {
    const db = await fixtureDatabase();
    try {
      const issue = createIssue(db, {
        description: "Aggregate current product facts",
        project_id: "demo",
        status: "in_progress",
        title: "Command Center"
      });
      db.sqlite.run("update issues set created_at=?, updated_at=? where id=?", [SOURCE_TIME, SOURCE_TIME, issue.id]);
      db.sqlite.run("update issue_events set created_at=? where issue_id=?", [SOURCE_TIME, issue.id]);
      const runID = insertRun(db, issue.id);
      insertAttention(db);
      recordHandoff(db, issue.id, handoff(issue.id), {
        recorded_at: SOURCE_TIME,
        source: "command-center-test"
      });
      const router = createRouter();
      registerCommandCenterRoutes(router, { database: db }, { now: () => new Date(NOW) });

      const response = await router.handle(new Request(`${BASE_URL}/api/command-center/summary?limit=5`));
      const body = await response.json() as Record<string, any>;

      expect(response.status).toBe(200);
      expect(body).toMatchObject({
        compatibility: {
          dual_write: "none-read-only-aggregate",
          handoff_read_authority: "issue_events:handoff.*.v1",
          work_read_authority: "issues-via-Work-adapter"
        },
        contract: "xw.command-center.summary.v1",
        failed_sections: [],
        generated_at: NOW,
        limits: { maximum: 25, requested: 5 },
        partial: false,
        requested_sections: ["attention", "active_work", "recent_deliveries", "system_health"],
        sections: {
          active_work: {
            counts: { returned: 1, total: 1 },
            freshness: { queried_at: NOW, state: "current" },
            items: [{
              id: issueIDToWorkID(issue.id),
              latest_run: {
                id: runID,
                phase: "running",
                progress: { stalled: { detected: false } },
                status: "running"
              },
              links: { self: expect.stringContaining("/api/works/") },
              status: "in_progress"
            }],
            status: "ok"
          },
          attention: {
            counts: { returned: 1, total: 1 },
            items: [{
              id: "xw:attention:attention_inbox_items:1",
              legacy_status: "new",
              links: { self: "/api/pi/attention-inbox/items/1" },
              status: "open"
            }],
            status: "ok"
          },
          recent_deliveries: {
            counts: { returned: 1, skipped_invalid: 0, total: 1 },
            items: [{
              id: makeDomainID("handoff", "derived", `command-center-${issue.id}`),
              links: { view: expect.stringContaining("#/handoffs/") },
              status: "draft"
            }],
            status: "ok"
          },
          system_health: {
            counts: { running: 1, total: 1 },
            links: { status: "/api/system/status" },
            status: "ok",
            summary: {
              database: { status: "ready" },
              run_progress: { active_runs: 1, projection_mode: "read_through_rebuild" }
            }
          }
        }
      });
      expect(body.sections.active_work.items[0].latest_run.progress).not.toHaveProperty("timeline");
    } finally {
      db.close();
    }
  });

  test("isolates a failed section and still returns successful requested partitions", async () => {
    const db = await fixtureDatabase();
    try {
      insertAttention(db);
      const readers = commandCenterSectionReaders(db);
      const router = createRouter();
      registerCommandCenterRoutes(router, { database: db }, {
        now: () => new Date(NOW),
        readers: {
          recent_deliveries: () => {
            throw new Error("fixture repository unavailable");
          }
        }
      });

      const response = await router.handle(new Request(
        `${BASE_URL}/api/command-center/summary?sections=attention,recent_deliveries&limit=1`
      ));
      const body = await response.json() as Record<string, any>;

      expect(response.status).toBe(200);
      expect(body).toMatchObject({
        failed_sections: ["recent_deliveries"],
        partial: true,
        requested_sections: ["attention", "recent_deliveries"],
        sections: {
          attention: { counts: { returned: 1 }, status: "ok" },
          recent_deliveries: {
            error: { code: "section_unavailable", message: "recent_deliveries query failed" },
            freshness: { state: "unknown" },
            status: "error"
          }
        }
      });
      expect(body.sections).not.toHaveProperty("active_work");
      expect(readers.attention({ limit: 1, now: new Date(NOW) }).counts.returned).toBe(1);
    } finally {
      db.close();
    }
  });

  test("keeps the active Work partition bounded on a large library", async () => {
    const db = await fixtureDatabase();
    try {
      const insert = db.sqlite.prepare(`
        insert into issues (project_id, title, description, status, priority, created_at, updated_at)
        values ('demo', ?, '', 'todo', ?, ?, ?)
      `);
      db.transaction(() => {
        for (let index = 0; index < 12_000; index += 1) {
          insert.run(`Large Work ${index}`, index, SOURCE_TIME, SOURCE_TIME);
        }
      }).immediate();
      const router = createDefaultRouter({ database: db });

      const startedAt = performance.now();
      const response = await router.handle(new Request(
        `${BASE_URL}/api/command-center/summary?sections=active_work&limit=10`
      ));
      const elapsedMs = performance.now() - startedAt;
      const body = await response.json() as Record<string, any>;

      expect(response.status).toBe(200);
      expect(body.sections.active_work).toMatchObject({
        counts: { returned: 10, total: 12_000 },
        status: "ok"
      });
      expect(body.sections.active_work.items).toHaveLength(10);
      expect(elapsedMs).toBeLessThan(2_000);
    } finally {
      db.close();
    }
  });

  test("rejects unbounded limits and unknown sections with actionable errors", async () => {
    const db = await fixtureDatabase();
    try {
      const router = createDefaultRouter({ database: db });
      const limit = await router.handle(new Request(`${BASE_URL}/api/command-center/summary?limit=26`));
      const section = await router.handle(new Request(`${BASE_URL}/api/command-center/summary?sections=unknown`));
      expect(limit.status).toBe(400);
      expect(await limit.json()).toEqual({ code: "invalid_limit", message: "limit must be an integer from 1 to 25" });
      expect(section.status).toBe(400);
      expect(await section.json()).toEqual({ code: "invalid_section", message: "unknown Command Center section: unknown" });
    } finally {
      db.close();
    }
  });
});

async function fixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-command-center-"));
  tempRoots.push(root);
  const db = await openDatabase({ stateDir: join(root, "state") });
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

function insertAttention(db: RunnerDatabase): void {
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
  createAttentionInboxItem(db, {
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
  }, new Date(SOURCE_TIME));
}

function handoff(issueID: number): HandoffRecord {
  return {
    baseline_revision: "git:base",
    changed_files: ["backend-ts/src/http/commandCenterApi.ts"],
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
