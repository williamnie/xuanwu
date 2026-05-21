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
	db *sql.DB
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
	st := &Store{db: db}
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
		issuesSchema,
		issueEventsSchema,
		`create index if not exists idx_issues_queue on issues(project_id, status, priority, created_at)`,
	}
	for _, stmt := range stmts {
		if _, err := s.db.Exec(stmt); err != nil {
			return fmt.Errorf("init sqlite: %w", err)
		}
	}
	return nil
}

func now() string {
	return time.Now().UTC().Format(time.RFC3339)
}
