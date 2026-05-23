package store

import (
	"context"
	"database/sql"
	"errors"
)

const lastSessionProjectKey = "sessions.last_project_id"

func (s *Store) SetLastSessionProject(ctx context.Context, projectID string) error {
	_, err := s.db.ExecContext(ctx, `insert into app_preferences (key, value, updated_at)
		values (?, ?, ?)
		on conflict(key) do update set value=excluded.value, updated_at=excluded.updated_at`,
		lastSessionProjectKey, projectID, now())
	return err
}

func (s *Store) LastSessionProject(ctx context.Context) (string, error) {
	var projectID string
	err := s.db.QueryRowContext(ctx, `select value from app_preferences where key=?`, lastSessionProjectKey).Scan(&projectID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return "", ErrNotFound
		}
		return "", err
	}
	return projectID, nil
}
