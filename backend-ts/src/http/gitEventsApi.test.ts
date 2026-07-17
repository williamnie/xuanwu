import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { createIssue } from "../db/repositories/issueCreate.ts";
import { recordHandoff } from "../db/repositories/handoffs.ts";
import { listExternalLinksByExternal } from "../db/repositories/externalLinks.ts";
import { listAttentionInboxItems } from "../db/repositories/intakeRuns.ts";
import { makeDomainID } from "../xuanwu/coreDomainContracts.ts";
import type { HandoffRecord } from "../domain/handoff/contracts.ts";
import { createDefaultRouter, createRequestHandler } from "./server.ts";

const BASE_URL = "http://127.0.0.1:3008";
const TOKEN = "runner-bearer-secret";
const roots: string[] = [];

afterEach(async () => {
  while (roots.length > 0) await rm(roots.pop()!, { force: true, recursive: true });
});

describe("Git provider event connector", () => {
  test("normalizes GitHub PR events, dedupes deliveries, and links the mapped Work/Handoff", async () => {
    const database = await fixtureDatabase();
    try {
      seedProject(database, "demo");
      const issue = createIssue(database, { project_id: "demo", status: "triage", title: "Git event target" });
      const handoffID = makeDomainID("handoff", "derived", "git-event-1");
      recordHandoff(database, issue.id, handoff(issue.id, handoffID), {
        recorded_at: "2026-07-18T00:00:00.000Z", source: "test"
      });
      const handle = createRequestHandler(createDefaultRouter({ database }), TOKEN);
      const mapping = await handle(authenticated("/api/integrations/git/mappings", {
        audit: { actor: "operator:1", correlation_id: "map-1", event_id: "mapping-1", reason: "fixture" },
        project_id: "demo", provider: "github", repository: "acme/demo"
      }, "PUT"));
      const payload = githubPullRequest(issue.id, handoffID);
      const first = await handle(githubEvent(payload, "delivery-1"));
      const replay = await handle(githubEvent(payload, "delivery-1"));
      const firstBody = await first.json() as Record<string, unknown>;
      const replayBody = await replay.json() as Record<string, unknown>;
      const links = listExternalLinksByExternal(database, { externalID: "acme/demo:101", source: "github" });

      expect(mapping.status).toBe(201);
      expect(first.status).toBe(202);
      expect(replay.status).toBe(200);
      expect(firstBody).toMatchObject({ linked: true, replayed: false, repository: "acme/demo", event: { event_type: "pull_request", status: "linked" } });
      expect(replayBody).toMatchObject({ replayed: true });
      expect(links.map((item) => item.external_type).sort()).toEqual(["git_event", "git_handoff", "git_work"]);
      expect(database.sqlite.query("select count(*) as count from external_events").get()).toEqual({ count: 1 });
      expect(database.sqlite.query("select count(*) as count from git_repo_mapping_events").get()).toEqual({ count: 1 });
    } finally { database.close(); }
  });

  test("routes an unknown GitLab repository to the existing Attention inbox and safely resyncs out-of-order events", async () => {
    const database = await fixtureDatabase();
    try {
      const handle = createRequestHandler(createDefaultRouter({ database }), TOKEN);
      const unknown = await handle(gitlabEvent({
        object_attributes: { id: 80, updated_at: "2026-07-18T00:01:00.000Z" },
        project: { path_with_namespace: "acme/unmapped" }, user: { username: "reviewer" }
      }, "delivery-unknown", "Merge Request Hook"));
      const resync = await handle(authenticated("/api/integrations/git/gitlab/resync", {
        events: [
          { delivery_id: "old-check", event_name: "Pipeline Hook", payload: { object_attributes: { id: 1, updated_at: "2026-07-18T00:00:00.000Z" }, project: { path_with_namespace: "acme/unmapped" } } },
          { delivery_id: "delivery-unknown", event_name: "Merge Request Hook", payload: { object_attributes: { id: 80, updated_at: "2026-07-18T00:01:00.000Z" }, project: { path_with_namespace: "acme/unmapped" }, user: { username: "reviewer" } } }
        ]
      }));
      const unknownBody = await unknown.json() as Record<string, unknown>;
      const resyncBody = await resync.json() as Record<string, unknown>;
      const attention = listAttentionInboxItems(database, { source: "gitlab" });

      expect(unknown.status).toBe(202);
      expect(unknownBody).toMatchObject({ linked: false, event: { status: "attention" }, attention_id: expect.any(Number) });
      expect(resync.status).toBe(202);
      expect(resyncBody).toMatchObject({ summary: { attention: 2, replayed: 1, synced: 2 } });
      expect(attention).toHaveLength(1);
      expect(attention[0]).toMatchObject({ primary_intent: "status_question", suggested_actions: ["map_repository"], status: "new" });
      expect(database.sqlite.query("select count(*) as count from external_events").get()).toEqual({ count: 2 });
    } finally { database.close(); }
  });
});

async function fixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-git-events-"));
  roots.push(root);
  return await openDatabase({ dbPath: join(root, "runner.sqlite") });
}

function seedProject(database: RunnerDatabase, id: string): void {
  database.sqlite.run("insert into projects (id, name, cwd, auto_run, created_at, updated_at) values (?, ?, ?, ?, ?, ?)", [
    id, id, `/tmp/${id}-${crypto.randomUUID()}`, 0, "2026-07-18T00:00:00.000Z", "2026-07-18T00:00:00.000Z"
  ]);
}

function authenticated(path: string, body: unknown, method = "POST"): Request {
  return new Request(`${BASE_URL}${path}`, {
    body: JSON.stringify(body), headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, method
  });
}

function githubEvent(payload: Record<string, unknown>, deliveryID: string): Request {
  return new Request(`${BASE_URL}/api/integrations/git/github/events`, {
    body: JSON.stringify(payload), headers: {
      authorization: `Bearer ${TOKEN}`, "content-type": "application/json",
      "x-github-delivery": deliveryID, "x-github-event": "pull_request"
    }, method: "POST"
  });
}

function gitlabEvent(payload: Record<string, unknown>, deliveryID: string, event: string): Request {
  return new Request(`${BASE_URL}/api/integrations/git/gitlab/events`, {
    body: JSON.stringify(payload), headers: {
      authorization: `Bearer ${TOKEN}`, "content-type": "application/json",
      "x-gitlab-event": event, "x-gitlab-event-uuid": deliveryID
    }, method: "POST"
  });
}

function githubPullRequest(issueID: number, handoffID: string): Record<string, unknown> {
  return {
    action: "opened", repository: { full_name: "Acme/Demo" }, sender: { login: "octocat" },
    pull_request: {
      body: `Work xw:work:issues:${issueID}\nHandoff ${handoffID}`,
      id: 101, title: "Ready for review", updated_at: "2026-07-18T00:01:00.000Z"
    }
  };
}

function handoff(issueID: number, id: string): HandoffRecord {
  return {
    schema_version: 1 as const, id: id as HandoffRecord["id"], work_id: makeDomainID("work", "issues", issueID), run_ids: [], evidence_ids: [], revision: 0,
    status: "draft" as const, summary: "Git event fixture", created_at: "2026-07-18T00:00:00.000Z", updated_at: "2026-07-18T00:00:00.000Z",
    baseline_revision: "git:base", final_revision: "git:tree", review_ref: "git:tree", changed_files: ["backend-ts/src/http/gitEventsApi.ts"],
    delivery: { mode: "local_changes" as const, working_tree_ref: "git:tree" }, delivery_actions: [], risks: [],
    rollback: { availability: "not_required" as const, destructive: false, refs: [] },
    review: { required: false, state: "not_requested" as const, reviewer_refs: [] }
  };
}
