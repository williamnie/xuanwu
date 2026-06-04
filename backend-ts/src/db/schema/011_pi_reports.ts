import type { SqlMigration } from "../migrations.ts";

const PI_REPORTS_SQL = `
create table if not exists pi_reports (
  id integer primary key autoincrement,
  project_id text not null default '',
  type text not null,
  status text not null default 'generated',
  source text not null default 'manual',
  since_at text not null default '',
  until_at text not null default '',
  delegation_id text not null default '',
  heartbeat_id text not null default '',
  issue_ids_json text not null default '[]',
  summary_json text not null default '{}',
  body_json text not null default '{}',
  generated_at text not null,
  created_at text not null,
  updated_at text not null
);
`;

export const piReportsMigration: SqlMigration = {
  id: "011_pi_reports",
  sql: PI_REPORTS_SQL,
  apply(sqlite) {
    sqlite.run(PI_REPORTS_SQL);
    addReportColumn(sqlite, "status", "'generated'");
    addReportColumn(sqlite, "source", "'manual'");
    addReportColumn(sqlite, "since_at", "''");
    addReportColumn(sqlite, "until_at", "''");
    addReportColumn(sqlite, "delegation_id", "''");
    addReportColumn(sqlite, "heartbeat_id", "''");
    addReportColumn(sqlite, "issue_ids_json", "'[]'");
    sqlite.run(`
      create index if not exists idx_pi_reports_scope
        on pi_reports(project_id, generated_at desc, id desc)
    `);
    sqlite.run(`
      create index if not exists idx_pi_reports_delegation
        on pi_reports(delegation_id, generated_at desc, id desc)
    `);
  }
};

function addReportColumn(sqlite: Parameters<NonNullable<SqlMigration["apply"]>>[0], name: string, fallback: string): void {
  if (reportColumns(sqlite).has(name)) return;
  sqlite.run(`alter table pi_reports add column ${name} text not null default ${fallback}`);
}

function reportColumns(sqlite: Parameters<NonNullable<SqlMigration["apply"]>>[0]): Set<string> {
  return new Set(sqlite.query<{ name: string }, []>("pragma table_info(pi_reports)").all().map((row) => row.name));
}
