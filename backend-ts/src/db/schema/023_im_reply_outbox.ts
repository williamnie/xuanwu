import type { SqlMigration } from "../migrations.ts";

export const imReplyOutboxMigration: SqlMigration = {
  id: "023_im_reply_outbox",
  sql: `
create table if not exists im_reply_drafts (
  id integer primary key autoincrement,
  source text not null,
  external_event_id integer not null default 0,
  issue_id integer not null default 0,
  target_chat_id text not null default '',
  target_thread_id text not null default '',
  target_message_id text not null default '',
  content text not null,
  status text not null default 'pending',
  risk text not null default 'low',
  created_by text not null default 'pi',
  approval_action_id text not null default '',
  rejection_reason text not null default '',
  created_at text not null,
  updated_at text not null
);

create index if not exists idx_im_reply_drafts_status
  on im_reply_drafts(status, created_at desc, id desc);

create index if not exists idx_im_reply_drafts_source_target
  on im_reply_drafts(source, target_chat_id, target_thread_id, target_message_id, created_at desc, id desc);

create table if not exists sync_outbox (
  id integer primary key autoincrement,
  source text not null,
  reply_draft_id integer not null default 0,
  external_event_id integer not null default 0,
  issue_id integer not null default 0,
  target_chat_id text not null default '',
  target_thread_id text not null default '',
  target_message_id text not null default '',
  content text not null,
  status text not null default 'queued',
  risk text not null default 'low',
  created_by text not null default 'pi',
  approval_action_id text not null default '',
  created_at text not null,
  updated_at text not null
);

create unique index if not exists idx_sync_outbox_reply_draft
  on sync_outbox(reply_draft_id);

create index if not exists idx_sync_outbox_status
  on sync_outbox(status, created_at desc, id desc);

create index if not exists idx_sync_outbox_source_target
  on sync_outbox(source, target_chat_id, target_thread_id, target_message_id, created_at desc, id desc);
`
};
