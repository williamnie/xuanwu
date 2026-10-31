import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { validateToolArguments } from "@earendil-works/pi-ai";
import type { RunnerDatabase } from "../../db/database.ts";
import { listAutomations } from "../../db/repositories/automations.ts";
import type { AgentSession } from "../../db/repositories/agentSessions.ts";
import { getIssue, listIssueRuns, listIssues } from "../../db/repositories/issues.ts";
import { listIssueEvents } from "../../db/repositories/issueEvents.ts";
import { createIssueRun } from "../../db/repositories/issueRuns.ts";
import { getPiAction, listPiActionEvents, listPiActions } from "../../db/repositories/pi.ts";
import { getProject, type Project } from "../../db/repositories/projects.ts";
import { createHumanReviewRequest, readIssueDecisionProjection } from "../../domain/review/humanReview.ts";
import { createPiRunnerActions, type PiRunnerActionLayer } from "./runnerActions.ts";
import { createPiRunnerActionTools, PI_RUNNER_ACTION_TOOL_NAMES } from "./runnerActionTools.ts";
import { insertIssue as insertIssueRow, insertProject, useTestDatabase } from "../../testing/harness.ts";

import { HUMAN_REVIEW, HUMAN_REVIEW_RESPONSE, BATCH, VALID_ARGUMENTS, INVALID_ARGUMENTS, DELEGATED_CALLS, openDatabase, projectIDs, sessionKeys, fakeActions, detailedBatchItem, insertAgentProfile, openFixture, insertIssue, insertAgentSession } from "./runnerActionToolsFixtureHUMAN_REVIEW.ts";
import { toolByName, validateArgs, collectToolText, runTool } from "./runnerActionToolsFixtureToolByName.ts";

export function registerReturnsCompactExecutionStatusForOne() {
test("returns compact execution status for one issue without description or raw logs", async () => {
    const fixture = await openFixture();
    const actions = createPiRunnerActions(fixture.db, { project: fixture.project });
    const issueID = insertIssue(fixture.db, {
      description: "full issue body should stay out TOKEN=secret",
      projectID: fixture.project.id,
      status: "failed",
      title: "Broken issue"
    });
    fixture.db.sqlite.run(
      `insert into issue_runs
        (id, issue_id, attempt, status, provider, provider_session_id, started_at, ended_at, exit_reason, error)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "issue-1-attempt-1", issueID, 1, "failed", "codex", "thread-1",
        "2026-01-01T01:00:00Z", "2026-01-01T01:05:00Z", "error", "context window TOKEN=secret"
      ]
    );
    fixture.db.sqlite.run(
      `insert into issue_events (issue_id, type, payload, created_at) values (?, ?, ?, ?)`,
      [issueID, "issue.log", JSON.stringify({ text: "last useful line TOKEN=secret" }), "2026-01-01T01:04:00Z"]
    );

    const status = actions.issueExecutionStatus({ id: issueID }) as {
      issue: Record<string, unknown>;
      latest_run: Record<string, unknown>;
      recent_events: Array<Record<string, unknown>>;
    };

    expect(status.issue).toMatchObject({ id: issueID, status: "failed", title: "Broken issue" });
    expect(status.latest_run).toMatchObject({ attempt: 1, status: "failed", provider: "codex" });
    expect(status.recent_events).toEqual([
      expect.objectContaining({ type: "issue.log", payload_preview: expect.stringContaining("TOKEN=[redacted]") })
    ]);
    expect(JSON.stringify(status)).not.toContain("full issue body");
    expect(JSON.stringify(status)).not.toContain("TOKEN=secret");
  });

test("repo read-only actions are scoped, bounded, redacted, and audited", async () => {
    const fixture = await openFixture();
    mkdirSync(fixture.project.cwd, { recursive: true });
    writeFileSync(join(fixture.project.cwd, "README.md"), "# Demo\nTOKEN=secret\nneedle line\n");
    mkdirSync(join(fixture.project.cwd, "src"), { recursive: true });
    writeFileSync(join(fixture.project.cwd, "src", "App.tsx"), "export const App = 'needle';\n");
    mkdirSync(join(fixture.project.cwd, ".git"), { recursive: true });
    writeFileSync(join(fixture.project.cwd, ".git", "config"), "[core]\n");
    writeFileSync(join(fixture.project.cwd, "large.txt"), "x".repeat(4097));
    writeFileSync(join(fixture.project.cwd, "secret.token"), "needle\n");
    const actions = createPiRunnerActions(fixture.db, { project: fixture.project });

    expect(actions.readRepoTree({ path: ".", max_depth: 2 })).toMatchObject({
      items: expect.arrayContaining([
        expect.objectContaining({ path: "README.md", source: "repo_tree" }),
        expect.objectContaining({ path: "src", type: "directory" })
      ]),
      skipped: expect.arrayContaining([
        expect.objectContaining({ path: ".git", reason: expect.stringContaining("sensitive") }),
        expect.objectContaining({ path: "secret.token", reason: expect.stringContaining("sensitive") })
      ])
    });
    const searchResult = actions.searchRepo({ query: "needle", max_results: 5 });
    expect(searchResult).not.toMatchObject({
      skipped: expect.arrayContaining([expect.objectContaining({ path: "large.txt" })])
    });
    expect(searchResult).toMatchObject({
      truncated: false,
      results: [
        expect.objectContaining({ line_range: { end: 3, start: 3 }, path: "README.md", source: "repo_search" }),
        expect.objectContaining({ path: "src/App.tsx", source: "repo_search" })
      ],
      skipped: expect.arrayContaining([
        expect.objectContaining({ path: "secret.token", reason: expect.stringContaining("sensitive") })
      ])
    });
    expect(actions.searchRepo({ query: "needle", max_results: 1 })).toMatchObject({
      results: [expect.objectContaining({ path: "README.md" })],
      truncated: true
    });
    const excerpt = actions.readRepoExcerpt({ path: "README.md", start_line: 1, max_lines: 3 });
    expect(excerpt).toMatchObject({
      excerpt: expect.stringContaining("TOKEN=[redacted]"),
      line_range: { end: 3, start: 1 },
      path: "README.md",
      source: "repo_read_excerpt"
    });
    expect(JSON.stringify(excerpt)).not.toContain("TOKEN=secret");
    expect(() => actions.readRepoExcerpt({ path: "../outside.txt" })).toThrow(/project scope/);
    expect(() => actions.readRepoExcerpt({ path: join(fixture.project.cwd, "README.md") })).toThrow(/absolute/);
    expect(() => actions.readRepoExcerpt({ path: ".git/config" })).toThrow(/sensitive/);
    expect(actions.readRepoExcerpt({ path: "large.txt" })).toMatchObject({
      excerpt: "x".repeat(4096), line_range: { start: 1, end: 1 }, truncated: true
    });
    expect(readFileSync(join(fixture.project.cwd, "README.md"), "utf8")).toBe("# Demo\nTOKEN=secret\nneedle line\n");
    const repoActions = listPiActions(fixture.db).filter((action) => action.action_type.startsWith("repo."));

    expect(repoActions.map((action) => action.action_type).sort()).toEqual([
      "repo.read_excerpt",
      "repo.read_excerpt",
      "repo.read_excerpt",
      "repo.read_excerpt",
      "repo.read_excerpt",
      "repo.search",
      "repo.search",
      "repo.tree"
    ]);
    expect(repoActions.every((action) => !action.result_json.includes("TOKEN=secret"))).toBe(true);
    const auditedSearch = repoActions.find((action) => action.payload_json.includes('"max_results":5'));
    expect(JSON.parse(auditedSearch?.payload_json ?? "{}")).toEqual({
      max_results: 5,
      query: "needle"
    });
  });

test("read-only action gate does not create pending approvals under narrow mutation policy", async () => {
    const fixture = await openFixture();
    mkdirSync(fixture.project.cwd, { recursive: true });
    writeFileSync(join(fixture.project.cwd, "README.md"), "# Demo\nneedle\n");
    const issueID = insertIssue(fixture.db, {
      projectID: fixture.project.id,
      status: "todo",
      title: "Read-only issue"
    });
    insertAgentSession(fixture.db, { projectID: fixture.project.id, sessionKey: "codex:thread-readonly" });
    const actions = createPiRunnerActions(fixture.db, {
      authorization: {
        allowed_actions: ["issue.enqueue"],
        authorizedActions: [{ action_type: "issue.enqueue", issue_id: issueID, project_id: fixture.project.id }],
        mode: "delegated",
        scope: { project_id: fixture.project.id }
      },
      project: fixture.project
    });

    actions.projectStatus({});
    actions.readRepoTree({ path: ".", max_depth: 1 });
    actions.searchRepo({ query: "needle", max_results: 3 });
    actions.readRepoExcerpt({ path: "README.md", max_lines: 2 });
    actions.readIssue({ id: issueID });
    actions.issueExecutionStatus({ id: issueID });
    actions.listSessions({});
    actions.readSessionSummary({ session_key: "codex:thread-readonly" });
    actions.listSkills({});
    actions.listMcpRegistry({});

    const actionsAfterReads = listPiActions(fixture.db);
    expect(actionsAfterReads.map((action) => action.status)).not.toContain("pending");
    expect(actionsAfterReads.map((action) => action.gate_decision)).toEqual(
      actionsAfterReads.map(() => "execute")
    );
    expect(listPiActionEvents(fixture.db).map((event) => event.event_type)).not.toContain("pending_approval");

    const sideEffect = actions.commentIssue({ issue_id: issueID, body: "requires explicit mutation coverage" }) as {
      decision: string;
      status: string;
    };
    expect(sideEffect).toMatchObject({ decision: "deny", status: "denied" });
    expect(getIssue(fixture.db, issueID)?.comment_count).toBe(0);
  });
}
