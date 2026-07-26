import type { Database as SQLiteDatabase } from "bun:sqlite";
import type { SqlMigration } from "../migrations.ts";

export const collapsePiAgentsToSupervisorMigration: SqlMigration = {
  id: "055_collapse_pi_agents_to_supervisor",
  sql: "",
  apply(sqlite) {
    if (columnNames(sqlite, "project_pi_settings").has("pi_agent_id")) {
      sqlite.run(`update project_pi_settings set pi_agent_id='runner-default'
        where pi_agent_id<>'runner-default' and exists (select 1 from pi_agents where id='runner-default')`);
    }
    sqlite.run(`update pi_conversations set pi_agent_id='runner-default'
      where pi_agent_id<>'runner-default' and exists (select 1 from pi_agents where id='runner-default')`);
    sqlite.run(`delete from pi_agents where id<>'runner-default'
      and exists (select 1 from pi_agents where id='runner-default')`);
    sqlite.run(`update pi_agents
      set name='Xuanwu Supervisor', updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      where id='runner-default' and name in ('PI Assistant', 'Runner Agent', 'Runner Brain')`);
    sqlite.run(`update pi_agents
      set instructions='你是玄武 Xuanwu Supervisor，作为 Engineering Chief of Staff 将工程目标组织为 Work，监督 Run，以 Evidence 判定完成，并产出可审查的 Handoff；所有写操作必须经过确定性权限与审计门禁。',
          updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      where id='runner-default' and instructions in (
        '你是玄武的 Supervisor runtime，负责观察所有项目、调度 sessions/issues、提出 action 建议并沉淀工程记忆。',
        '你是全局 PI Assistant runtime，负责观察所有项目、调度 sessions/issues、提出 action 建议并沉淀记忆。',
        '你是全局 Runner Agent，负责观察所有项目、调度 sessions/issues、提出 action 建议并沉淀记忆。',
        '你是全局 Runner Brain，负责观察所有项目、调度 sessions/issues、提出 action 建议并沉淀记忆。'
      )`);
  }
};

function columnNames(sqlite: SQLiteDatabase, table: string): Set<string> {
  const rows = sqlite.query<{ name: string }, []>(`pragma table_info(${table})`).all();
  return new Set(rows.map((row) => row.name));
}
