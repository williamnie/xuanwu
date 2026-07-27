import type { SqlMigration } from "../migrations.ts";

export const projectMandatoryTakeoverMigration: SqlMigration = {
  id: "061_project_mandatory_takeover",
  sql: `
update pi_agents set enabled=1,
  updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
where id='runner-default' and enabled<>1;

update projects set auto_run=1,
  updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
where auto_run<>1;

insert into project_pi_settings (project_id, created_at, updated_at)
select p.id,
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
from projects p
where not exists (
  select 1 from project_pi_settings settings where settings.project_id=p.id
);
`
};
