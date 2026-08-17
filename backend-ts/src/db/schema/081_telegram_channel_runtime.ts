import type { SqlMigration } from "../migrations.ts";

/**
 * Telegram long polling needs a durable continuous-prefix cursor. Delivery
 * parts make deterministic message splitting restart-safe: a retry skips only
 * the chunks that already have a provider receipt.
 */
export const telegramChannelRuntimeMigration: SqlMigration = {
  id: "081_telegram_channel_runtime",
  sql: `
create table if not exists connector_cursors (
  connector_id text not null,
  scope text not null,
  position text not null,
  updated_at text not null,
  primary key (connector_id, scope)
);

create table if not exists connector_update_audits (
  connector_id text not null,
  update_id text not null,
  outcome text not null,
  reason text not null default '',
  created_at text not null,
  primary key (connector_id, update_id)
);

create table if not exists connector_delivery_parts (
  connector_id text not null,
  idempotency_key text not null,
  part_index integer not null,
  part_count integer not null,
  content_hash text not null,
  provider_request_ref text not null,
  created_at text not null,
  primary key (connector_id, idempotency_key, part_index)
);

create index if not exists idx_connector_delivery_parts_ref
  on connector_delivery_parts(connector_id, provider_request_ref);
`
};
