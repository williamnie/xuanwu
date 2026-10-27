import type { SqlMigration } from "../migrations.ts";

/**
 * 远程运行台账：中心重启后据此重新接上节点上仍在执行的运行，
 * 或在节点重启丢失运行时立即收口，而不是等待超时。
 */
export const remoteRunsMigration: SqlMigration = {
  id: "093_remote_runs",
  sql: `
create table if not exists remote_runs (
  run_ref text primary key,
  node_id text not null,
  issue_id integer not null,
  issue_run_id text not null,
  project_id text not null,
  provider text not null,
  status text not null default 'active',
  created_at text not null,
  updated_at text not null
);
create index if not exists idx_remote_runs_node_active on remote_runs(node_id, status);
`
};
