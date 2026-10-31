import { type RunnerDatabase } from "../db/database.ts";

import { useTestDatabase } from "../testing/harness.ts";

export const fixtureDatabase = useTestDatabase();

export function seedIssueEvents(db: RunnerDatabase): number {
  db.sqlite.run(`insert into projects (id, name, cwd, created_at, updated_at)
    values ('demo', 'Demo', '/tmp/demo', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`);
  db.sqlite.run(`insert into issues (project_id, title, status, created_at, updated_at)
    values ('demo', 'Projection fixture', 'in_progress', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`);
  const issueID = Number(db.sqlite.query<{ id: number }, []>("select last_insert_rowid() as id").get()?.id);
  const insert = db.sqlite.query(
    "insert into issue_events (issue_id, type, payload, created_at) values (?, ?, ?, ?)"
  );
  insert.run(issueID, "issue.created", '{"title":"Projection fixture"}', "2026-01-01T00:00:00Z");
  insert.run(issueID, "issue.log", JSON.stringify({
    type: "agent_message_delta",
    raw_method: "item/agentMessage/delta",
    text: "x".repeat(32 * 1024),
    raw_payload: "must-not-enter-summary"
  }), "2026-01-01T00:00:01Z");
  insert.run(issueID, "issue.status_changed", '{"status":"done"}', "2026-01-01T00:00:02Z");
  insert.run(issueID, "issue.comment", '{"author":"user","body":"keep exact"}', "2026-01-01T00:00:03Z");
  return issueID;
}
