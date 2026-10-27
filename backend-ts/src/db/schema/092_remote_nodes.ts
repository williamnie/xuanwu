import type { SqlMigration } from "../migrations.ts";

/**
 * 远程节点：主动连回中心的 Agent 端。只存密钥哈希；在线状态由连接投影，表内只记录最后一次握手。
 */
export const remoteNodesMigration: SqlMigration = {
  id: "092_remote_nodes",
  sql: `
create table if not exists nodes (
  id text primary key,
  name text not null,
  token_hash text not null unique,
  info_json text not null default '{}',
  last_seen_at text not null default '',
  last_remote_addr text not null default '',
  created_at text not null,
  updated_at text not null,
  revoked_at text not null default ''
);
`
};
