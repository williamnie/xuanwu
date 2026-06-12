import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../database.ts";
import { createExternalEvent } from "./externalEvents.ts";
import {
  createExternalLink,
  listExternalLinksByExternal,
  listExternalLinksByIssue
} from "./externalLinks.ts";
import { deleteIssue } from "./issueActions.ts";
import { createIssue } from "./issueCreate.ts";
import type { Issue } from "./issues.ts";

const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) await rm(root, { recursive: true, force: true });
  }
});

describe("external link repository", () => {
  test("creates a link from an external event to a runner issue", async () => {
    const db = await openFixtureDatabase();
    try {
      const issue = createLinkedIssue(db);
      const event = createExternalEvent(db, {
        content: "QA issue",
        dedupe_key: "qa:QA-123",
        external_id: "QA-123",
        source: "qa"
      });

      const link = createExternalLink(db, {
        conversation_id: "conv-1",
        external_event_id: event.id,
        external_type: "qa_issue",
        issue_id: issue.id,
        loop_run_id: "loop-1",
        relationship: "origin"
      }, new Date("2026-06-12T08:00:00Z"));

      expect(link).toMatchObject({
        conversation_id: "conv-1",
        external_event_id: event.id,
        external_id: "QA-123",
        external_type: "qa_issue",
        issue_id: issue.id,
        loop_run_id: "loop-1",
        project_id: "demo",
        relationship: "origin",
        source: "qa"
      });
    } finally {
      db.close();
    }
  });

  test("returns the existing record for duplicate links", async () => {
    const db = await openFixtureDatabase();
    try {
      const issue = createLinkedIssue(db);
      const input = { external_id: "QA-123", external_type: "qa_issue", issue_id: issue.id, source: "qa" };

      const first = createExternalLink(db, input, new Date("2026-06-12T08:00:00Z"));
      const duplicate = createExternalLink(db, input, new Date("2026-06-12T09:00:00Z"));

      expect(duplicate).toEqual(first);
      expect(db.sqlite.query("select count(*) as count from external_links").get()).toEqual({ count: 1 });
    } finally {
      db.close();
    }
  });

  test("lists links by runner issue newest first", async () => {
    const db = await openFixtureDatabase();
    try {
      const issue = createLinkedIssue(db);
      const other = createLinkedIssue(db, "other");
      const older = createExternalLink(db, {
        external_id: "QA-1",
        issue_id: issue.id,
        source: "qa"
      }, new Date("2026-06-12T08:00:00Z"));
      createExternalLink(db, {
        external_id: "QA-other",
        issue_id: other.id,
        source: "qa"
      }, new Date("2026-06-12T09:00:00Z"));
      const newer = createExternalLink(db, {
        external_id: "QA-2",
        issue_id: issue.id,
        source: "qa"
      }, new Date("2026-06-12T10:00:00Z"));

      expect(listExternalLinksByIssue(db, issue.id).map((item) => item.id)).toEqual([
        newer.id,
        older.id
      ]);
    } finally {
      db.close();
    }
  });

  test("lists links by external source and external id", async () => {
    const db = await openFixtureDatabase();
    try {
      const issue = createLinkedIssue(db);
      const match = createExternalLink(db, {
        external_id: "QA-123",
        issue_id: issue.id,
        source: "qa"
      });
      createExternalLink(db, { external_id: "QA-123", issue_id: issue.id, source: "im" });
      createExternalLink(db, { external_id: "QA-456", issue_id: issue.id, source: "qa" });

      expect(listExternalLinksByExternal(db, {
        externalID: "QA-123",
        source: "qa"
      }).map((item) => item.id)).toEqual([match.id]);
      expect(listExternalLinksByExternal(db, { source: "qa" }).map((item) => item.source)).toEqual([
        "qa",
        "qa"
      ]);
    } finally {
      db.close();
    }
  });

  test("retains historical links when a runner issue is deleted", async () => {
    const db = await openFixtureDatabase();
    try {
      const issue = createLinkedIssue(db);
      const link = createExternalLink(db, {
        external_id: "QA-123",
        issue_id: issue.id,
        source: "qa"
      });

      deleteIssue(db, issue.id);

      expect(listExternalLinksByIssue(db, issue.id)).toEqual([link]);
    } finally {
      db.close();
    }
  });
});

async function openFixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-external-links-"));
  tempRoots.push(root);
  return openDatabase({ stateDir: join(root, "state") });
}

function createLinkedIssue(db: RunnerDatabase, suffix = "main"): Issue {
  const cwd = join(tempRoots.at(-1) ?? tmpdir(), suffix);
  db.sqlite.run("insert into projects (id, name, cwd, created_at, updated_at) values (?, ?, ?, ?, ?)", [
    suffix === "main" ? "demo" : `demo-${suffix}`,
    `Demo ${suffix}`,
    cwd,
    "2026-06-12T08:00:00Z",
    "2026-06-12T08:00:00Z"
  ]);
  return createIssue(db, {
    description: `Issue ${suffix}`,
    project_id: suffix === "main" ? "demo" : `demo-${suffix}`,
    title: `Issue ${suffix}`
  });
}
