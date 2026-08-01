import type { SqlMigration } from "../migrations.ts";

/** 将恢复预算收敛为 Issue/Session 级；项目级字段保留为 0 以兼容既有 API。 */
export const unlimitedProjectRecoveryBudgetMigration: SqlMigration = {
  id: "065_unlimited_project_recovery_budget",
  sql: `
update project_pi_policies
set supervisor_max_recoveries_per_issue=6,
    supervisor_max_recoveries_per_project_per_hour=0;
`
};
