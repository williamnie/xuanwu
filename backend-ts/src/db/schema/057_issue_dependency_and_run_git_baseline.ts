import type { Database as SQLiteDatabase } from "bun:sqlite";
import { parseIssueDependencyDeclaration } from "../../domain/work/issueDependencyDeclaration.ts";
import type { SqlMigration } from "../migrations.ts";

type IssueRow = {
  created_at: string;
  description: string;
  id: number;
  project_id: string;
};

export const issueDependencyAndRunGitBaselineMigration: SqlMigration = {
  id: "057_issue_dependency_and_run_git_baseline",
  sql: "",
  apply(sqlite) {
    sqlite.run(`
      alter table issues add column dependency_issue_ids_json text not null default '[]'
        check(json_valid(dependency_issue_ids_json) and json_type(dependency_issue_ids_json)='array')
    `);
    sqlite.run(`
      alter table issues add column dependency_declaration_error text not null default ''
    `);
    sqlite.run(`
      alter table issue_runs add column git_base_revision text not null default ''
    `);
    backfillDeclaredDependencies(sqlite);
    repairDeferredGuardianEvidence(sqlite);
  }
};

function ensureIssueWorkShadow(sqlite: SQLiteDatabase, issueID: number): void {
  sqlite.run(`
    insert or ignore into works (
      id, project_id, type, title, goal, status, acceptance_json, provenance_json,
      workflow_ref, revision, created_at, updated_at
    )
    select
      'xw:work:issues:' || id,
      project_id,
      'engineering_task',
      title,
      case when trim(description)<>'' then description else title end,
      status,
      '{"completion_rule":"all_required","criteria":[{"description":"Satisfy the authoritative Issue description and verification requirements.","id":"issue-delivery","required":true,"verification_policy_ref":"issue-work-verification:v1"}],"requires_handoff":true,"version":1}',
      json_object(
        'causes', json_array(),
        'origin', json_object(
          'authority', 'issues',
          'completeness', 'legacy_incomplete',
          'external_id', cast(id as text),
          'kind', 'issue',
          'missing_fields', json_array('actor','correlation_id'),
          'occurred_at', created_at
        )
      ),
      'issues:' || id || ':workflow:legacy',
      0,
      created_at,
      updated_at
    from issues
    where id=?
  `, [issueID]);
}

function repairDeferredGuardianEvidence(sqlite: SQLiteDatabase): void {
  const rows = sqlite.query<{ cooldown_until: string; evidence_json: string; id: string }, []>(`
    select id, cooldown_until, evidence_json from pi_guardian_decisions
    where state='deferred' and cooldown_until<>''
  `).all();
  for (const row of rows) {
    const evidence = jsonArray(row.evidence_json);
    if (evidence.some((item) => Object.hasOwn(item, "guardian_decision_rate_limit"))) continue;
    evidence.push({
      guardian_decision_rate_limit: {
        limit: 0,
        retry_at: row.cooldown_until,
        scope: "migration_recovered",
        window_ms: 0
      }
    });
    sqlite.run("update pi_guardian_decisions set evidence_json=? where id=?", [
      JSON.stringify(evidence),
      row.id
    ]);
  }
}

function jsonArray(value: string): Array<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is Record<string, unknown> =>
        Boolean(item) && typeof item === "object" && !Array.isArray(item)
      )
      : [];
  } catch {
    return [];
  }
}

function backfillDeclaredDependencies(sqlite: SQLiteDatabase): void {
  const issues = sqlite.query<IssueRow, []>(
    "select id, project_id, description, created_at from issues order by id"
  ).all();
  const byID = new Map(issues.map((issue) => [issue.id, issue]));
  for (const issue of issues) {
    const declaration = parseIssueDependencyDeclaration(issue.description);
    sqlite.run(
      "update issues set dependency_issue_ids_json=?, dependency_declaration_error=? where id=?",
      [JSON.stringify(declaration.issue_ids), declaration.error, issue.id]
    );
    if (declaration.error !== "") continue;
    for (const dependencyID of declaration.issue_ids) {
      const dependency = byID.get(dependencyID);
      if (!dependency || dependency.project_id !== issue.project_id) continue;
      ensureIssueWorkShadow(sqlite, issue.id);
      ensureIssueWorkShadow(sqlite, dependencyID);
      const relationID = issueDependencyRelationID(issue.id, dependencyID);
      sqlite.run(`
        insert or ignore into work_relations (
          relation_id, project_id, kind, source_work_id, target_work_id, actor_json,
          reason, correlation_id, audit_event_ref, occurred_at, created_at, updated_at
        ) values (?, ?, 'depends_on', ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        relationID,
        issue.project_id,
        issueWorkID(issue.id),
        issueWorkID(dependencyID),
        '{"id":"issue-dependency-backfill","kind":"runner"}',
        "Materialize dependency declared in the Issue description",
        relationID,
        `migration:${relationID}`,
        issue.created_at,
        issue.created_at,
        issue.created_at
      ]);
    }
  }
}

function issueWorkID(issueID: number): string {
  return `xw:work:issues:${issueID}`;
}

function issueDependencyRelationID(issueID: number, dependencyID: number): string {
  return `issue-dependency:${issueID}:${dependencyID}`;
}
