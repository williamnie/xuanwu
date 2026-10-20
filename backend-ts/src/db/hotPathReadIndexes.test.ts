import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "./migrations.ts";

function plan(sqlite: Database, sql: string, args: Array<number | string>): string[] {
  const statement = sqlite.prepare(`explain query plan ${sql}`);
  try {
    return (statement.all(...args) as Array<{ detail: string }>).map(({ detail }) => detail);
  } finally { statement.finalize(); }
}

test("run hot paths and the issue_runs sync trigger seek attempts by issue_run_id", () => {
  const sqlite = new Database(":memory:");
  try {
    runMigrations(sqlite);
    for (const [sql, args, index] of [
      ["select sequence from run_attempts where issue_run_id=? order by sequence desc limit 1", ["run"], "idx_run_attempts_issue_run_sequence"],
      // trg_issue_runs_run_attempt_update 在每次 Run 状态写入时执行同形更新。
      ["update run_attempts set updated_at=? where issue_run_id=? and sequence=1", ["now", "run"], "idx_run_attempts_issue_run_sequence"],
      ["select run_id from issue_runs where status='in_progress' order by started_at desc, id desc limit 32", [], "idx_issue_runs_in_progress_started"],
      ["select count(*) from issue_runs where status='in_progress'", [], "idx_issue_runs_in_progress_started"],
      ["select id from issue_runs where provider=? and provider_session_id=?", ["codex", "thread"], "idx_issue_runs_provider_session"],
      ["select session_key from agent_sessions where provider_session_id=? order by updated_at desc, session_key asc limit 2", ["thread"], "idx_agent_sessions_provider_session_updated"],
      ["select session_key from agent_sessions order by updated_at desc, session_key asc limit 20", [], "idx_agent_sessions_updated"],
      ["select session_key from agent_sessions where agent_role=? order by updated_at desc, session_key asc limit 50", ["worker"], "idx_agent_sessions_role_updated"],
      ["select id from notifications where read_at='' order by created_at desc, id desc limit 100", [], "idx_notifications_unread_created"],
      ["select payload from notifications where event='pi.needs_user' and issue_id=?", [1], "idx_notifications_issue_event"],
      ["select id from pi_action_events where event_type=? order by id asc", ["optional_skill.called"], "idx_pi_action_events_type_id"],
      ["select id from im_reply_drafts where issue_id in (?) order by updated_at desc, id desc limit 500", [1], "idx_im_reply_drafts_issue_updated"],
      ["select id from sync_outbox where issue_id in (?) order by updated_at desc, id desc limit 500", [1], "idx_sync_outbox_issue_updated"],
      ["select id from pi_guardian_decisions where created_at>=? order by created_at asc, id asc", ["2026-01-01"], "idx_pi_guardian_decisions_created"]
    ] as const) {
      const detail = plan(sqlite, sql, [...args]);
      expect(detail.join("\n")).toContain(index);
      expect(detail.some((line) => /^SCAN (run_attempts|issue_runs|agent_sessions|notifications|pi_action_events|im_reply_drafts|sync_outbox|pi_guardian_decisions)$/.test(line))).toBe(false);
      expect(detail.some((line) => line.includes("USE TEMP B-TREE"))).toBe(false);
    }
    for (const sql of [
      "select id from im_reply_drafts where approval_action_id in (?) or external_event_id in (?)",
      "select id from sync_outbox where approval_action_id in (?)"
    ]) {
      expect(plan(sqlite, sql, sql.includes("external") ? ["action", 1] : ["action"])
        .some((line) => line.startsWith("SCAN "))).toBe(false);
    }
    runMigrations(sqlite);
    expect(sqlite.query("pragma quick_check").get()).toEqual({ quick_check: "ok" });
  } finally { sqlite.close(); }
});

test("run progress walks the newest normalized events through the issue/type index", () => {
  const sqlite = new Database(":memory:");
  try {
    runMigrations(sqlite);
    const detail = plan(sqlite, `
      select id, payload, created_at from issue_events
      where issue_id=? and type='issue.log' and julianday(created_at)>=julianday(?)
        and (?='' or julianday(created_at)<=julianday(?))
        and json_valid(payload)
        and json_extract(payload, '$.run_event.contract')='xw.run-event.v1'
      order by id desc limit 5001
    `, [1, "2026-01-01T00:00:00Z", "", ""]);
    expect(detail.join("\n")).toMatch(/SEARCH issue_events USING INDEX idx_issue_events_issue_(type|id_desc)/);
    expect(detail.some((line) => line.includes("USE TEMP B-TREE"))).toBe(false);
  } finally { sqlite.close(); }
});

test("idempotency and reply-draft lookups can use their partial unique indexes", () => {
  const sqlite = new Database(":memory:");
  try {
    runMigrations(sqlite);
    expect(plan(sqlite, "select id from pi_actions where idempotency_key=? and idempotency_key<>'' order by created_at asc, id asc limit 1", ["key"]).join("\n"))
      .toContain("ux_pi_actions_idempotency_key");
    expect(plan(sqlite, "select id from sync_outbox where reply_draft_id=? and reply_draft_id>0", [1]).join("\n"))
      .toContain("idx_sync_outbox_reply_draft");
  } finally { sqlite.close(); }
});
