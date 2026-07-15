import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openDatabase, type RunnerDatabase } from "../../db/database.ts";
import { createIssue } from "../../db/repositories/issueCreate.ts";
import { createPiAction, createPiActionEvent } from "../../db/repositories/pi/actions.ts";
import { createPiDelegation } from "../../db/repositories/pi/delegations.ts";
import { createPiIssueCompletionWatch } from "../../db/repositories/pi/issueCompletionWatches.ts";
import { issueIDToWorkID } from "./issueAdapter.ts";
import {
  listPiWorkRelations,
  piActionRelationLifecycle,
  piDelegationRelationLifecycle,
  piWatchRelationLifecycle
} from "./piRelationAdapter.ts";

const tempRoots: string[] = [];
const PROJECT_ID = "demo";
const ADR_PATH = "docs/architecture/xuanwu/0015-pi-work-relation-adapter.md";
const REPO_ROOT = resolve(import.meta.dir, "../../../..");

afterEach(async () => {
  while (tempRoots.length > 0) {
    const path = tempRoots.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

describe("PI carrier to Work relation adapter", () => {
  test("maps Action, Delegation and Completion Watch fixtures without creating duplicate Work", async () => {
    const db = await openFixtureDatabase();
    try {
      insertProject(db, PROJECT_ID);
      const first = createIssue(db, { project_id: PROJECT_ID, status: "todo", title: "First" });
      const second = createIssue(db, { project_id: PROJECT_ID, status: "done", title: "Second" });
      createPiDelegation(db, {
        allowed_actions_json: ["issue.comment"],
        audit_source: "fixture-user",
        id: "delegation-a",
        project_id: PROJECT_ID,
        scope_json: { issue_ids: [first.id, second.id] },
        status: "active",
        title: "Fixture delegation"
      });
      createActionWithEvent(db, {
        delegation_id: "delegation-a",
        id: "action-completed",
        issue_id: first.id,
        status: "completed"
      });
      createActionWithEvent(db, {
        delegation_id: "delegation-a",
        id: "action-executing",
        issue_id: first.id,
        status: "executing"
      });
      const watch = createPiIssueCompletionWatch(db, {
        id: "watch-a",
        issue_ids: [first.id, second.id],
        origin_conversation_id: "conversation-a",
        project_id: PROJECT_ID,
        source_event_id: "external-event-a",
        source_message_id: "message-a"
      });
      db.sqlite.run(
        "update pi_issue_completion_watches set status='notified', updated_at=? where id=?",
        ["2026-01-03T00:00:00Z", watch.id]
      );

      const firstProjection = listPiWorkRelations(db, { project_id: PROJECT_ID });
      const replay = listPiWorkRelations(db, { project_id: PROJECT_ID });
      const counts = relationKindCounts(firstProjection.relations);

      expect(counts).toEqual({ authorization: 2, execution: 2, observation: 2 });
      expect(firstProjection.unmapped).toEqual([]);
      expect(replay).toEqual(firstProjection);
      expect(new Set(firstProjection.relations.map((item) => item.relation_id)).size)
        .toBe(firstProjection.relations.length);
      expect(firstProjection.relations.filter((item) =>
        item.kind === "authorization" && item.work_id === issueIDToWorkID(first.id)
      )).toHaveLength(1);
      expect(firstProjection.relations).toContainEqual(expect.objectContaining({
        kind: "execution",
        lifecycle: "completed",
        source_ref: expect.objectContaining({
          authority: "pi_actions",
          event_refs: [expect.stringMatching(/^xw:evidence:pi_action_events:/)],
          external_id: "action-completed",
          source_status: "completed"
        }),
        work_id: issueIDToWorkID(first.id)
      }));
      expect(firstProjection.relations).toContainEqual(expect.objectContaining({
        kind: "execution",
        lifecycle: "active",
        source_ref: expect.objectContaining({ external_id: "action-executing" })
      }));
      expect(firstProjection.relations).toContainEqual(expect.objectContaining({
        kind: "authorization",
        lifecycle: "active",
        source_ref: expect.objectContaining({
          authority: "pi_delegations",
          external_id: "delegation-a",
          related_refs: expect.arrayContaining([
            { authority: "pi_actions", external_id: "action-completed" },
            { authority: "pi_actions", external_id: "action-executing" }
          ])
        }),
        work_id: issueIDToWorkID(second.id)
      }));
      expect(firstProjection.relations).toContainEqual(expect.objectContaining({
        kind: "observation",
        lifecycle: "completed",
        source_ref: expect.objectContaining({
          authority: "pi_issue_completion_watches",
          external_id: "watch-a",
          related_refs: expect.arrayContaining([
            { authority: "pi_conversations", external_id: "conversation-a" },
            { authority: "source_events", external_id: "external-event-a" },
            { authority: "source_messages", external_id: "message-a" }
          ])
        })
      }));
      expect(rowCount(db, "works")).toBe(0);
      expect(rowCount(db, "work_relations")).toBe(0);
    } finally {
      db.close();
    }
  });

  test("keeps empty and historical carriers readable and reports deterministic mapping gaps", async () => {
    const db = await openFixtureDatabase();
    try {
      insertProject(db, PROJECT_ID);
      expect(listPiWorkRelations(db)).toEqual({ relations: [], unmapped: [] });

      const issue = createIssue(db, { project_id: PROJECT_ID, status: "triage", title: "Historical" });
      createPiAction(db, {
        action_type: "issue.create",
        id: "action-created-work",
        issue_id: 0,
        project_id: PROJECT_ID,
        result_json: JSON.stringify({ id: issue.id }),
        status: "completed"
      });
      createPiAction(db, {
        action_type: "issue.comment",
        id: "action-payload-ref",
        issue_id: 0,
        payload_json: JSON.stringify({ issue_id: String(issue.id) }),
        project_id: "",
        status: "historic_state"
      });
      createPiAction(db, {
        action_type: "issue.list",
        id: "action-no-work",
        issue_id: 0,
        project_id: PROJECT_ID,
        status: "completed"
      });
      createPiAction(db, {
        action_type: "issue.comment",
        id: "action-missing-work",
        issue_id: 999999,
        project_id: PROJECT_ID,
        status: "failed"
      });
      createPiAction(db, {
        action_type: "issue.comment",
        id: "action-project-mismatch",
        issue_id: issue.id,
        project_id: "other-project",
        status: "denied"
      });
      createPiDelegation(db, {
        authorization_json: JSON.stringify({ scope: { issue_ids: [issue.id] } }),
        id: "delegation-legacy-scope",
        project_id: PROJECT_ID,
        scope_json: {},
        status: "paused"
      });
      insertEmptyWatch(db, "watch-without-items", PROJECT_ID);
      db.sqlite.run("update pi_issue_completion_watches set status='old_watch' where id='watch-without-items'");

      const projection = listPiWorkRelations(db, { project_id: PROJECT_ID });

      expect(projection.relations).toContainEqual(expect.objectContaining({
        kind: "execution",
        lifecycle: "completed",
        source_ref: expect.objectContaining({ external_id: "action-created-work" }),
        work_id: issueIDToWorkID(issue.id)
      }));
      expect(projection.relations).toContainEqual(expect.objectContaining({
        kind: "execution",
        lifecycle: "legacy_unknown",
        source_ref: expect.objectContaining({ external_id: "action-payload-ref", source_status: "historic_state" }),
        work_id: issueIDToWorkID(issue.id)
      }));
      expect(projection.relations).toContainEqual(expect.objectContaining({
        kind: "authorization",
        lifecycle: "paused",
        source_ref: expect.objectContaining({ external_id: "delegation-legacy-scope" }),
        work_id: issueIDToWorkID(issue.id)
      }));
      expect(projection.unmapped).toEqual(expect.arrayContaining([
        expect.objectContaining({ reason: "missing_work_reference", source_ref: expect.objectContaining({ external_id: "action-no-work" }) }),
        expect.objectContaining({ candidate_issue_id: 999999, reason: "missing_work", source_ref: expect.objectContaining({ external_id: "action-missing-work" }) }),
        expect.objectContaining({ candidate_issue_id: issue.id, reason: "project_mismatch", source_ref: expect.objectContaining({ external_id: "action-project-mismatch" }) }),
        expect.objectContaining({
          reason: "missing_work_reference",
          source_ref: expect.objectContaining({ external_id: "watch-without-items", source_status: "old_watch" })
        })
      ]));
      expect(rowCount(db, "works")).toBe(0);
      expect(rowCount(db, "work_relations")).toBe(0);
    } finally {
      db.close();
    }
  });

  test("normalizes carrier lifecycles without changing Work state", () => {
    expect(["candidate", "pending", "approved"].map(piActionRelationLifecycle)).toEqual([
      "pending", "pending", "pending"
    ]);
    expect(["executing", "completed", "failed", "denied", "snoozed", "skipped", "old"]
      .map(piActionRelationLifecycle)).toEqual([
        "active", "completed", "failed", "failed", "paused", "cancelled", "legacy_unknown"
      ]);
    expect(["active", "paused", "expired", "old"].map(piDelegationRelationLifecycle)).toEqual([
      "active", "paused", "expired", "legacy_unknown"
    ]);
    expect(["active", "satisfied", "notified", "cancelled", "failed", "old"]
      .map(piWatchRelationLifecycle)).toEqual([
        "active", "completed", "completed", "cancelled", "failed", "legacy_unknown"
      ]);
  });

  test("keeps the compatibility window, rollback, deletion gates and non-migration list canonical", () => {
    const adr = readFileSync(resolve(REPO_ROOT, ADR_PATH), "utf8");
    for (const phrase of [
      "execution / authorization / observation",
      "legacy carrier 是唯一 source of truth",
      "不写 `works` 或 `work_relations`",
      "不迁移清单",
      "W1",
      "W2",
      "P11.03/P11.04/P11.05/P11.09",
      "LLM"
    ]) expect(adr).toContain(phrase);
  });
});

async function openFixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-pi-work-relations-"));
  tempRoots.push(root);
  return openDatabase({ stateDir: join(root, "state") });
}

function insertProject(db: RunnerDatabase, id: string): void {
  const timestamp = "2026-01-01T00:00:00Z";
  db.sqlite.run(
    `insert into projects (id, name, cwd, provider, auto_run, created_at, updated_at)
     values (?, ?, ?, 'codex', 1, ?, ?)`,
    [id, id, `/tmp/${id}`, timestamp, timestamp]
  );
}

function createActionWithEvent(
  db: RunnerDatabase,
  input: { delegation_id: string; id: string; issue_id: number; status: string }
): void {
  createPiAction(db, {
    action_type: "issue.comment",
    delegation_id: input.delegation_id,
    id: input.id,
    issue_id: input.issue_id,
    project_id: PROJECT_ID,
    status: input.status
  });
  createPiActionEvent(db, {
    action_id: input.id,
    actor: "fixture",
    delegation_id: input.delegation_id,
    event_type: "fixture_event",
    issue_id: input.issue_id,
    project_id: PROJECT_ID,
    reason: "fixture audit"
  });
}

function insertEmptyWatch(db: RunnerDatabase, id: string, projectID: string): void {
  const timestamp = "2026-01-01T00:00:00Z";
  db.sqlite.run(
    `insert into pi_issue_completion_watches
      (id, idempotency_key, project_id, condition, status, created_at, updated_at)
     values (?, ?, ?, '{}', 'active', ?, ?)`,
    [id, `fixture:${id}`, projectID, timestamp, timestamp]
  );
}

function relationKindCounts(relations: Array<{ kind: string }>): Record<string, number> {
  return relations.reduce<Record<string, number>>((counts, relation) => {
    counts[relation.kind] = (counts[relation.kind] ?? 0) + 1;
    return counts;
  }, {});
}

function rowCount(db: RunnerDatabase, table: string): number {
  return db.sqlite.query<{ count: number }, []>(`select count(*) as count from ${table}`).get()?.count ?? 0;
}
