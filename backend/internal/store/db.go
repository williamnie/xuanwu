package store

import (
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

func (s *Store) init() error {
	stmts := []string{
		`pragma foreign_keys = on`,
		projectsSchema,
		issueTemplatesSchema,
		issuesSchema,
		issueEventsSchema,
		issueRunsSchema,
		cronTasksSchema,
		uploadsSchema,
		appPreferencesSchema,
		projectHoldsSchema,
		`create index if not exists idx_issues_queue on issues(project_id, status, priority, created_at)`,
		`create index if not exists idx_issue_runs_issue on issue_runs(issue_id, attempt)`,
		`create index if not exists idx_cron_tasks_due on cron_tasks(status, next_run_at)`,
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
	if !columns["sort_order"] {
		_, err := s.db.Exec(`alter table projects add column sort_order integer not null default 0`)
		if err != nil {
			return fmt.Errorf("migrate projects.sort_order: %w", err)
		}
	}
	return s.backfillProjectSortOrder()
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
		"template_id":        `alter table issues add column template_id text not null default ''`,
		"prompt_template":    `alter table issues add column prompt_template text not null default ''`,
		"auto_retry_next_at": `alter table issues add column auto_retry_next_at text not null default ''`,
		"auto_retry_reason":  `alter table issues add column auto_retry_reason text not null default ''`,
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
