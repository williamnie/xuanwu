import type { Database as SQLiteDatabase } from "bun:sqlite";
import type { SqlMigration } from "../migrations.ts";

/**
 * 为 interaction resolver 增加可恢复租约。
 *
 * 旧实现会在业务 resolver 运行前直接把 binding 标为 consumed；进程若在业务
 * 动作与回执之间退出，token 会永久失效。新增列保持 additive：pending 先 claim
 * 为 executing，只有 resolver 返回后才 consumed；过期 lease 可由同一受约束回调
 * 重新 claim，业务 authority 继续负责幂等副作用。
 */
export const imInteractionResolutionLeaseMigration: SqlMigration = {
  id: "073_im_interaction_resolution_lease",
  sql: "",
  apply(sqlite) {
    addColumn(sqlite, "claimed_action_id", "text not null default ''");
    addColumn(sqlite, "lease_id", "text not null default ''");
    addColumn(sqlite, "lease_expires_at", "text not null default ''");
    addColumn(sqlite, "resolution_json", "text not null default ''");
    addColumn(sqlite, "resolved_at", "text not null default ''");
    return undefined;
  }
};

function addColumn(sqlite: SQLiteDatabase, name: string, definition: string): void {
  const exists = sqlite.query<{ count: number }, [string]>(
    "select count(*) as count from pragma_table_info('im_interaction_bindings') where name=?"
  ).get(name)?.count === 1;
  if (!exists) sqlite.run(`alter table im_interaction_bindings add column ${name} ${definition}`);
}
