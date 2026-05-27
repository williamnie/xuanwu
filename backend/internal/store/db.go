package store

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"time"

	_ "modernc.org/sqlite"
)

type Store struct {
	db      *sql.DB
	dataDir string
}

func Open(path string) (*Store, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, err
	}
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	st := &Store{db: db, dataDir: dataDir(path)}
	if err := st.init(); err != nil {
		db.Close()
		return nil, err
	}
	return st, nil
}

func (s *Store) Close() error {
	return s.db.Close()
}

func (s *Store) Ping(ctx context.Context) error {
	return s.db.PingContext(ctx)
}

func (s *Store) init() error {
	stmts := []string{
		`pragma foreign_keys = on`,
		projectsSchema,
		agentProfilesSchema,
		issueTemplatesSchema,
		issuesSchema,
		issueEventsSchema,
		issueRunsSchema,
		sessionTurnReferencesSchema,
		sessionCommandEventsSchema,
		cronTasksSchema,
		uploadsSchema,
		appPreferencesSchema,
		projectHoldsSchema,
		nightlyBatchesSchema,
		nightlyBatchItemsSchema,
		`create index if not exists idx_issues_queue on issues(project_id, status, priority, created_at)`,
		`create index if not exists idx_issue_runs_issue on issue_runs(issue_id, attempt)`,
		`create index if not exists idx_agent_profiles_provider on agent_profiles(provider)`,
		`create index if not exists idx_session_turn_references_turn on session_turn_references(provider_session_id, provider_turn_id)`,
		`create index if not exists idx_session_command_events_session on session_command_events(provider_session_id, id)`,
		`create index if not exists idx_cron_tasks_due on cron_tasks(status, next_run_at)`,
		`create index if not exists idx_nightly_batches_project on nightly_batches(project_id, status, id)`,
		`create index if not exists idx_nightly_items_issue on nightly_batch_items(issue_id)`,
	}
	for _, stmt := range stmts {
		if _, err := s.db.Exec(stmt); err != nil {
			return fmt.Errorf("init sqlite: %w", err)
		}
	}
	if err := s.migrateProjectColumns(); err != nil {
		return err
	}
	if err := s.migrateIssueColumns(); err != nil {
		return err
	}
	if err := s.migrateIssueRunColumns(); err != nil {
		return err
	}
	if err := s.backfillIssueRunProviderIDs(); err != nil {
		return err
	}
	if err := s.migrateCronTaskColumns(); err != nil {
		return err
	}
	return s.ensureSeedIssueTemplate()
}

func (s *Store) UploadRoot() string {
	return filepath.Join(s.dataDir, "uploads", "images")
}

func dataDir(path string) string {
	abs, err := filepath.Abs(path)
	if err != nil {
		return filepath.Dir(path)
	}
	return filepath.Dir(abs)
}

func now() string {
	return time.Now().UTC().Format(time.RFC3339)
}

func (s *Store) migrateProjectColumns() error {
	columns, err := s.tableColumns("projects")
	if err != nil {
		return err
	}
	if !columns["provider"] {
		_, err := s.db.Exec(`alter table projects add column provider text not null default 'codex'`)
		if err != nil {
			return fmt.Errorf("migrate projects.provider: %w", err)
		}
	}
	if !columns["provider_config_json"] {
		_, err := s.db.Exec(`alter table projects add column provider_config_json text not null default '{}'`)
		if err != nil {
			return fmt.Errorf("migrate projects.provider_config_json: %w", err)
		}
	}
	if !columns["sort_order"] {
		_, err := s.db.Exec(`alter table projects add column sort_order integer not null default 0`)
		if err != nil {
			return fmt.Errorf("migrate projects.sort_order: %w", err)
		}
	}
	if !columns["default_agent_profile_id"] {
		_, err := s.db.Exec(`alter table projects add column default_agent_profile_id text not null default ''`)
		if err != nil {
			return fmt.Errorf("migrate projects.default_agent_profile_id: %w", err)
		}
	}
	if err := s.backfillProjectProvider(); err != nil {
		return err
	}
	return s.backfillProjectSortOrder()
}

func (s *Store) backfillProjectProvider() error {
	_, err := s.db.Exec(`update projects set
		provider=case when provider='' then 'codex' else provider end,
		provider_config_json=case when provider_config_json='' then '{}' else provider_config_json end`)
	return err
}

func (s *Store) backfillProjectSortOrder() error {
	var zeroCount int
	if err := s.db.QueryRow(`select count(*) from projects where sort_order=0`).Scan(&zeroCount); err != nil {
		return err
	}
	if zeroCount == 0 {
		return nil
	}

	rows, err := s.db.Query(`select id from projects
		order by case when sort_order=0 then 1 else 0 end, sort_order asc, created_at desc, id asc`)
	if err != nil {
		return err
	}
	defer rows.Close()

	ids := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return err
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		return err
	}

	for index, id := range ids {
		if _, err := s.db.Exec(`update projects set sort_order=? where id=?`, index+1, id); err != nil {
			return err
		}
	}
	return nil
}

func (s *Store) migrateIssueColumns() error {
	columns, err := s.tableColumns("issues")
	if err != nil {
		return err
	}
	additions := map[string]string{
		"template_id":            `alter table issues add column template_id text not null default ''`,
		"prompt_template":        `alter table issues add column prompt_template text not null default ''`,
		"agent_profile_id":       `alter table issues add column agent_profile_id text not null default ''`,
		"source_session_id":      `alter table issues add column source_session_id text not null default ''`,
		"source_turn_id":         `alter table issues add column source_turn_id text not null default ''`,
		"source_excerpt":         `alter table issues add column source_excerpt text not null default ''`,
		"workflow_snapshot_json": `alter table issues add column workflow_snapshot_json text not null default ''`,
		"auto_retry_next_at":     `alter table issues add column auto_retry_next_at text not null default ''`,
		"auto_retry_reason":      `alter table issues add column auto_retry_reason text not null default ''`,
	}
	for name, stmt := range additions {
		if columns[name] {
			continue
		}
		if _, err := s.db.Exec(stmt); err != nil {
			return fmt.Errorf("migrate issues.%s: %w", name, err)
		}
	}
	return nil
}

func (s *Store) migrateIssueRunColumns() error {
	columns, err := s.tableColumns("issue_runs")
	if err != nil {
		return err
	}
	additions := map[string]string{
		"provider":            `alter table issue_runs add column provider text not null default 'codex'`,
		"provider_session_id": `alter table issue_runs add column provider_session_id text not null default ''`,
		"provider_turn_id":    `alter table issue_runs add column provider_turn_id text not null default ''`,
		"agent_profile_id":    `alter table issue_runs add column agent_profile_id text not null default ''`,
		"capability_summary":  `alter table issue_runs add column capability_summary text not null default ''`,
		"selection_reason":    `alter table issue_runs add column selection_reason text not null default ''`,
	}
	for name, stmt := range additions {
		if columns[name] {
			continue
		}
		if _, err := s.db.Exec(stmt); err != nil {
			return fmt.Errorf("migrate issue_runs.%s: %w", name, err)
		}
	}
	return nil
}

func (s *Store) backfillIssueRunProviderIDs() error {
	_, err := s.db.Exec(`update issue_runs set
		provider=case when provider='' then 'codex' else provider end,
		provider_session_id=case when provider_session_id='' then codex_thread_id else provider_session_id end,
		provider_turn_id=case when provider_turn_id='' then codex_turn_id else provider_turn_id end`)
	return err
}

func (s *Store) migrateCronTaskColumns() error {
	columns, err := s.tableColumns("cron_tasks")
	if err != nil {
		return err
	}
	additions := map[string]string{
		"last_status": `alter table cron_tasks add column last_status text not null default ''`,
		"last_result": `alter table cron_tasks add column last_result text not null default ''`,
	}
	for name, stmt := range additions {
		if columns[name] {
			continue
		}
		if _, err := s.db.Exec(stmt); err != nil {
			return fmt.Errorf("migrate cron_tasks.%s: %w", name, err)
		}
	}
	return nil
}

func (s *Store) tableColumns(table string) (map[string]bool, error) {
	rows, err := s.db.Query(`pragma table_info(` + table + `)`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	columns := map[string]bool{}
	for rows.Next() {
		var cid int
		var name, typ string
		var notnull, pk int
		var dflt any
		if err := rows.Scan(&cid, &name, &typ, &notnull, &dflt, &pk); err != nil {
			return nil, err
		}
		columns[name] = true
	}
	return columns, rows.Err()
}
