import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { recordEvidenceRecords } from "../db/repositories/evidence.ts";
import { listNotifications } from "../db/repositories/notifications.ts";
import { recordIssueEvent } from "../db/repositories/issueEvents.ts";
import { listPiNotificationIntents } from "../db/repositories/pi.ts";
import {
  createLocalBranchCommitHandoffService,
  resolveLocalGitHandoffProjectPolicy,
  type LocalBranchCommitHandoffRequest,
  type LocalGitHandoffAuditEvent
} from "../domain/handoff/localBranchCommit.ts";
import { EventBus } from "../events/bus.ts";
import { recordHandoffDelivery } from "../notifications/handoffNotifier.ts";
import { createDefaultRouter } from "./server.ts";

const BASE_URL = "http://127.0.0.1:3008";
const NOW = "2026-07-17T08:00:00.000Z";
const tempRoots: string[] = [];

afterEach(async () => {
  for (const path of tempRoots.splice(0)) rmSync(path, { force: true, recursive: true });
});

describe("Handoff HTTP API and delivery notification", () => {
  test("creates a real local Git Handoff, persists one stream record, and returns list/detail plus deep-linked notification", async () => {
    const db = await fixture();
    const repository = initRepository();
    try {
      const issueID = insertIssue(db);
      const workID = `xw:work:issues:${issueID}` as LocalBranchCommitHandoffRequest["work_id"];
      const runID = insertRun(db, issueID) as LocalBranchCommitHandoffRequest["run_ids"][number];
      const evidenceID = `xw:evidence:git:handoff-api-${issueID}` as LocalBranchCommitHandoffRequest["git_evidence"]["evidence_id"];
      writeFileSync(join(repository, "selected.txt"), "delivery change\n");
      const bus = new EventBus();
      const liveEvents: unknown[] = [];
      const stop = bus.observe((event) => liveEvents.push(event));
      const service = createLocalBranchCommitHandoffService({
        audit_sink: {
          record(event: LocalGitHandoffAuditEvent) {
            recordIssueEvent(db, issueID, event.event_type, event);
          }
        },
        now: () => NOW,
        project_policy_reader: {
          read: () => resolveLocalGitHandoffProjectPolicy({
            allowed_actions_json: '["handoff.commit"]',
            allowed_base_branches: ["main"],
            branch_prefix: "xw/",
            branch_reuse: "same_baseline",
            commit_identity: { name: "Xuanwu Runner", email: "xuanwu@example.test" },
            commit_subject_prefixes: ["feat(handoff):"],
            max_commit_subject_length: 120,
            policy_ref: "project-policy:fixture:handoff-local-git@1",
            project_id: "fixture"
          })
        }
      });

      const local = await service.execute({
        audit: {
          actor: { id: `runner:issue-${issueID}`, kind: "runner" },
          correlation_id: `issue-${issueID}-local-handoff`,
          intent_event_id: `issue_events:${issueID}:handoff:intent`,
          outcome_event_id: `issue_events:${issueID}:handoff:outcome`,
          rollback_event_id: `issue_events:${issueID}:handoff:rollback`
        },
        commit_message: "feat(handoff): deliver API smoke",
        git_evidence: {
          evidence_id: evidenceID,
          producer: { id: `runner:issue-${issueID}`, kind: "runner" },
          run_id: runID
        },
        linked_evidence: [],
        project_id: "fixture",
        repository_path: repository,
        repository_ref: "git-repository:handoff-api-fixture",
        run_ids: [runID],
        runs: [{ id: runID, work_id: workID }],
        selected_paths: ["selected.txt"],
        work_id: workID,
        work_title: "Handoff API smoke"
      });
      recordEvidenceRecords(db, issueID, [local.git_evidence], { recorded_at: NOW, source: "handoff-api-smoke" });
      const stored = recordHandoffDelivery({
        bus,
        database: db,
        handoff: local.handoff,
        issue_id: issueID,
        recorded_at: NOW,
        source: "local-branch-commit-service"
      });
      const replay = recordHandoffDelivery({
        bus,
        database: db,
        handoff: local.handoff,
        issue_id: issueID,
        recorded_at: NOW,
        source: "local-branch-commit-service"
      });
      const router = createDefaultRouter({ bus, database: db });

      const list = await router.handle(new Request(
        `${BASE_URL}/api/handoffs?work_id=${encodeURIComponent(workID)}&status=ready`
      ));
      const listBody = await list.json() as Record<string, any>;
      const detail = await router.handle(new Request(
        `${BASE_URL}/api/handoffs/${encodeURIComponent(local.handoff.id)}`
      ));
      const detailBody = await detail.json() as Record<string, any>;
      const notifications = listNotifications(db, { projectID: "fixture", unreadOnly: true });

      expect(stored).toMatchObject({ created: true, notification: { event: "handoff.ready" } });
      expect(replay).toMatchObject({ created: false, notification: null });
      expect(git(repository, "rev-parse", local.branch_ref)).toBe(local.commit_revision);
      expect(list.status).toBe(200);
      expect(listBody).toMatchObject({
        has_more: false,
        items: [{
          delivery: {
            branch_ref: local.branch_ref,
            commit_ref: local.commit_revision,
            mode: "branch_commit"
          },
          delivery_status: { overall: "ready" },
          id: local.handoff.id,
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
          actions: [{ action: "commit", current_status: "succeeded" }],
          overall: "ready",
          refreshed_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/)
        },
        diff_summary: {
          availability: "available",
          changed_files: ["selected.txt"],
          detail_level: "per_file_v2",
          diff_stats: { changed_path_count: 1, insertions: 1 }
        },
        handoff: { changed_files: ["selected.txt"], id: local.handoff.id },
        issue: {
          id: issueID,
          project_id: "fixture",
          status: "in_progress",
          title: "Handoff API smoke"
        },
        notification_summary: {
          handoff_id: local.handoff.id,
          href: `#/work/${encodeURIComponent(workID)}/delivery/${encodeURIComponent(local.handoff.id)}`
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
        branch_ref: local.branch_ref,
        commit_ref: local.commit_revision,
        evidence_count: 1,
        handoff_id: local.handoff.id,
        href: `#/work/${encodeURIComponent(workID)}/delivery/${encodeURIComponent(local.handoff.id)}`,
        risk_count: 0
      });
      expect(notifications[0]!.payload).not.toContain("selected.txt");
      expect(liveEvents).toEqual([
        expect.objectContaining({ payload: notifications[0]!.payload, type: "handoff.notification" })
      ]);
      expect(db.sqlite.query<{ count: number }, []>(
        "select count(*) as count from issue_events where type='handoff.prepared.v1'"
      ).get()?.count).toBe(1);
      stop();
    } finally {
      db.close();
    }
  });

  test("returns actionable invalid filters and missing detail states", async () => {
    const db = await fixture();
    try {
      const router = createDefaultRouter({ database: db });
      const invalid = await router.handle(new Request(`${BASE_URL}/api/handoffs?delivery_mode=unknown`));
      const missing = await router.handle(new Request(
        `${BASE_URL}/api/handoffs/${encodeURIComponent("xw:handoff:derived:missing")}`
      ));
      expect(invalid.status).toBe(400);
      expect(await invalid.json()).toEqual({ code: "invalid_delivery_mode", message: "Handoff delivery_mode is invalid" });
      expect(missing.status).toBe(404);
      expect(await missing.json()).toEqual({ code: "handoff_not_found", message: "Handoff not found" });
    } finally {
      db.close();
    }
  });
});

async function fixture(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "xuanwu-handoff-api-"));
  tempRoots.push(root);
  const db = await openDatabase({ stateDir: join(root, "state") });
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
