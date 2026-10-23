import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../../db/database.ts";
import { recordEvidenceRecords } from "../../db/repositories/evidence.ts";
import { listNotifications } from "../../db/repositories/notifications.ts";
import { recordIssueEvent } from "../../db/repositories/issueEvents.ts";
import { listPiNotificationIntents } from "../../db/repositories/pi.ts";
import { createGitEvidenceCollector } from "../../domain/evidence/gitCollector.ts";
import type { HandoffRecord } from "../../domain/handoff/contracts.ts";
import { EventBus } from "../../events/bus.ts";
import { recordHandoffDelivery } from "../../notifications/handoffNotifier.ts";
import { createDefaultRouter } from "../server.ts";
import { useDatabaseCleanup } from "../../testing/harness.ts";

const trackDatabase = useDatabaseCleanup();

const BASE_URL = "http://127.0.0.1:3008";
const NOW = "2026-07-17T08:00:00.000Z";
const tempRoots: string[] = [];

afterEach(async () => {
  for (const path of tempRoots.splice(0)) rmSync(path, { force: true, recursive: true });
});

describe("Handoff HTTP API and delivery notification", () => {
  test("persists one Handoff stream record, and returns list/detail plus deep-linked notification", async () => {
    const db = await fixture();
    const repository = initRepository();
    const issueID = insertIssue(db);
    const workID = `xw:work:issues:${issueID}` as const;
    const runID = insertRun(db, issueID) as `xw:run:issue_runs:${string}`;
    writeFileSync(join(repository, "selected.txt"), "delivery change\n");
    const bus = new EventBus();
    const liveEvents: unknown[] = [];
    const stop = bus.observe((event) => liveEvents.push(event));
    const gitEvidence = await createGitEvidenceCollector().collect({
      repository_path: repository,
      untracked_policy: "exclude",
      context: {
        evidence_id: `xw:evidence:git:handoff-api-${issueID}`, work_id: workID, run_id: runID,
        producer: { id: `runner:issue-${issueID}`, kind: "runner" },
        audit_event_ref: `issue-${issueID}-local-handoff`, collected_at: NOW, source_ref: "git-repository:handoff-api-fixture"
      }
    });
    const snapshot = `git-snapshot:${gitEvidence.decisive_output.facts.snapshot_sha256}`;
    const handoff: HandoffRecord = {
      schema_version: 1, id: `xw:handoff:derived:handoff-api-${issueID}`, work_id: workID, run_ids: [runID],
      evidence_ids: [gitEvidence.id], revision: 0, status: "ready", summary: "Handoff API smoke",
      created_at: NOW, updated_at: NOW, baseline_revision: snapshot, final_revision: snapshot,
      review_ref: `handoff-api:${issueID}`, changed_files: ["selected.txt"],
      delivery: { mode: "local_changes", working_tree_ref: snapshot }, delivery_actions: [], risks: [],
      rollback: { availability: "not_required", destructive: false, reason: "fixture", refs: [] },
      review: { required: false, state: "not_applicable", reviewer_refs: [] }
    };
    recordEvidenceRecords(db, issueID, [gitEvidence], { recorded_at: NOW, source: "handoff-api-smoke" });
    const stored = recordHandoffDelivery({
      bus,
      database: db,
      handoff,
      issue_id: issueID,
      recorded_at: NOW,
      source: "handoff-api-smoke"
    });
    const replay = recordHandoffDelivery({
      bus,
      database: db,
      handoff,
      issue_id: issueID,
      recorded_at: NOW,
      source: "handoff-api-smoke"
    });
    const router = createDefaultRouter({ bus, database: db });

    const list = await router.handle(new Request(
      `${BASE_URL}/api/handoffs?work_id=${encodeURIComponent(workID)}&status=ready`
    ));
    const listBody = await list.json() as Record<string, any>;
    const detail = await router.handle(new Request(
      `${BASE_URL}/api/handoffs/${encodeURIComponent(handoff.id)}`
    ));
    const detailBody = await detail.json() as Record<string, any>;
    const notifications = listNotifications(db, { projectID: "fixture", unreadOnly: true });

    expect(stored).toMatchObject({ created: true, notification: { event: "handoff.ready" } });
    expect(stored.notification?.message).toContain("当前凭证未提供 CI、合并结果");
    expect(stored.notification?.message).toContain("部署未确认");
    expect(stored.notification?.message).toContain("不等于全部通过");
    expect(replay).toMatchObject({ created: false, notification: null });
    expect(list.status).toBe(200);
    expect(listBody).toMatchObject({
      has_more: false,
      items: [{
        delivery: { mode: "local_changes" },
        delivery_status: { overall: "ready" },
        id: handoff.id,
        issue: {
          id: issueID,
          project_id: "fixture",
          status: "in_progress",
          title: "Handoff API smoke"
        },
        next_step: "Open delivery artifact",
        revision: 0,
        status: "ready"
      }]
    });
    expect(detail.status).toBe(200);
    expect(detailBody).toMatchObject({
      delivery_status: {
        overall: "ready",
        refreshed_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/)
      },
      diff_summary: {
        availability: "available",
        changed_files: ["selected.txt"],
        detail_level: "per_file_v2",
        diff_stats: { changed_path_count: 1, insertions: 1 }
      },
      handoff: { changed_files: ["selected.txt"], id: handoff.id },
      issue: {
        id: issueID,
        project_id: "fixture",
        status: "in_progress",
        title: "Handoff API smoke"
      },
      notification_summary: {
        handoff_id: handoff.id,
        href: `#/work/${encodeURIComponent(workID)}/delivery/${encodeURIComponent(handoff.id)}`
      }
    });
    expect(notifications).toHaveLength(1);
    expect(listPiNotificationIntents(db, { issueId: issueID })).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "handoff_ready",
        state: "sent",
        target_channel: "runner_ui"
      })
    ]));
    expect(JSON.parse(notifications[0]!.payload)).toMatchObject({
      evidence_count: 1,
      handoff_id: handoff.id,
      href: `#/work/${encodeURIComponent(workID)}/delivery/${encodeURIComponent(handoff.id)}`,
      risk_count: 0
    });
    expect(notifications[0]!.payload).not.toContain("selected.txt");
    expect(liveEvents).toEqual([
      expect.objectContaining({ payload: notifications[0]!.payload, type: "handoff.notification" })
    ]);
    stop();
  });

  test("returns actionable invalid filters and missing detail states", async () => {
    const db = await fixture();
    const router = createDefaultRouter({ database: db });
    const invalid = await router.handle(new Request(`${BASE_URL}/api/handoffs?delivery_mode=unknown`));
    const missing = await router.handle(new Request(
      `${BASE_URL}/api/handoffs/${encodeURIComponent("xw:handoff:derived:missing")}`
    ));
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ code: "invalid_delivery_mode", message: "Handoff delivery_mode is invalid" });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ code: "handoff_not_found", message: "Handoff not found" });
  });
});

async function fixture(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "xuanwu-handoff-api-"));
  tempRoots.push(root);
  const db = await openDatabase({ stateDir: join(root, "state") }).then(trackDatabase);
  db.sqlite.run(
    `insert into projects (id, name, cwd, provider, created_at, updated_at)
     values ('fixture', 'fixture', '/tmp/fixture', 'codex', ?, ?)`,
    [NOW, NOW]
  );
  return db;
}

function insertIssue(db: RunnerDatabase): number {
  db.sqlite.run(
    "insert into issues (project_id, title, status, created_at, updated_at) values ('fixture', ?, 'in_progress', ?, ?)",
    ["Handoff API smoke", NOW, NOW]
  );
  const id = db.sqlite.query<{ id: number }, []>("select last_insert_rowid() as id").get()?.id;
  if (!id) throw new Error("missing issue id");
  return id;
}

function insertRun(db: RunnerDatabase, issueID: number): string {
  const id = `issue-${issueID}-attempt-1`;
  db.sqlite.run(
    `insert into issue_runs
      (id, issue_id, attempt, status, provider, provider_session_id, provider_turn_id, started_at, ended_at)
     values (?, ?, 1, 'done', 'codex', 'handoff-api-session', 'handoff-api-turn', ?, ?)`,
    [id, issueID, NOW, NOW]
  );
  return `xw:run:issue_runs:${id}`;
}

function initRepository(): string {
  const path = mkdtempSync(join(tmpdir(), "xw-handoff-api-git-"));
  tempRoots.push(path);
  git(path, "init", "--initial-branch=main");
  writeFileSync(join(path, "selected.txt"), "base\n");
  git(path, "add", "selected.txt");
  git(path, "commit", "-m", "initial fixture");
  return path;
}

function git(repository: string, ...args: string[]): string {
  const result = Bun.spawnSync([
    "git",
    "-c", "user.name=Handoff API Fixture",
    "-c", "user.email=handoff-api@example.test",
    "-C", repository,
    ...args
  ], {
    env: {
      GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      PATH: process.env.PATH ?? ""
    },
    stderr: "pipe",
    stdout: "pipe"
  });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}
