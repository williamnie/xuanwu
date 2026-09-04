import type { SqlMigration } from "../migrations.ts";

const LEGACY_DEFAULT = "你是玄武 Xuanwu Supervisor，作为 Engineering Chief of Staff 将工程目标组织为 Work，监督 Run，以 Evidence 判定完成，并产出可审查的 Handoff；所有写操作必须经过确定性权限与审计门禁。";
const NATURAL_DEFAULT = "先回答用户真正关心的问题，再补必要理由；说人话，避免不必要的内部术语和流程播报。";

export const supervisorNaturalInstructionsMigration: SqlMigration = {
  id: "084_supervisor_natural_instructions",
  sql: "",
  apply(sqlite) {
    sqlite.run(
      `update pi_agents
          set instructions=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        where id='runner-default' and instructions=?`,
      [NATURAL_DEFAULT, LEGACY_DEFAULT]
    );
    return undefined;
  }
};
