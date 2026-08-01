import type { Database as SQLiteDatabase } from "bun:sqlite";
import type { SqlMigration } from "../migrations.ts";
import { runAttemptRelationsMigration } from "./042_run_attempt_relations.ts";

/** 删除 pending_verification，并把等待 PI 判断建模为 in_progress + 已结束 Run。 */
export const piOwnedIssueLifecycleMigration: SqlMigration = {
  id: "064_pi_owned_issue_lifecycle",
  sql: "",
  apply(sqlite: SQLiteDatabase): void {
    sqlite.run("update issues set status='in_progress' where status='pending_verification'");
    sqlite.run("update works set status='in_progress' where status='pending_verification'");
    sqlite.run("update issue_runs set status='succeeded' where status in ('done', 'pending_verification')");
    sqlite.run(`update works set acceptance_json=(
      select json_object(
        'criteria', json_group_array(json_object(
          'description', coalesce(json_extract(value, '$.description'), ''),
          'id', coalesce(json_extract(value, '$.id'), ''),
          'required', json_extract(value, '$.required')
        )),
        'version', coalesce(json_extract(works.acceptance_json, '$.version'), 1)
      )
      from json_each(works.acceptance_json, '$.criteria')
    ) where json_valid(acceptance_json)`);
    if (tableColumns(sqlite, "project_pi_policies").has("verification_policy_json")) {
      sqlite.run("alter table project_pi_policies drop column verification_policy_json");
    }

    sqlite.run("drop trigger if exists trg_issue_runs_run_attempt_insert");
    sqlite.run("drop trigger if exists trg_issue_runs_run_attempt_update");
    runAttemptRelationsMigration.apply?.(sqlite);
    sqlite.run(`update run_attempts set
      status=case legacy_status
        when 'in_progress' then 'running'
        when 'succeeded' then 'succeeded'
        when 'failed' then 'failed'
        when 'cancelled' then 'cancelled'
        else null end,
      mapping_error=case when legacy_status in ('in_progress', 'succeeded', 'failed', 'cancelled')
        then '' else 'unsupported issue_run status: ' || legacy_status end`);
  }
};

function tableColumns(sqlite: SQLiteDatabase, table: string): Set<string> {
  return new Set(sqlite.query<{ name: string }, []>(`pragma table_info(${table})`).all().map((row) => row.name));
}
