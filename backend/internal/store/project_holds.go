package store

import (
	"context"
	"database/sql"
	"errors"
)

func (s *Store) SetProjectHold(ctx context.Context, projectID string, hold ProjectHold) (Project, error) {
	if _, err := s.GetProject(ctx, projectID); err != nil {
		return Project{}, err
	}
	t := now()
	if hold.HoldSince == "" {
		hold.HoldSince = t
	}
	_, err := s.db.ExecContext(ctx, `insert into project_holds
		(project_id, reason, message, hold_since, next_check_at, last_check_at,
		last_check_error, updated_at)
		values (?, ?, ?, ?, ?, ?, ?, ?)
		on conflict(project_id) do update set reason=excluded.reason,
		message=excluded.message, hold_since=excluded.hold_since,
		next_check_at=excluded.next_check_at, last_check_at=excluded.last_check_at,
		last_check_error=excluded.last_check_error, updated_at=excluded.updated_at`,
		projectID, hold.Reason, hold.Message, hold.HoldSince, hold.NextCheckAt,
		hold.LastCheckAt, hold.LastCheckError, t)
	if err != nil {
		return Project{}, err
	}
	return s.GetProject(ctx, projectID)
}

func (s *Store) ClearProjectHold(ctx context.Context, projectID string) (Project, error) {
	res, err := s.db.ExecContext(ctx, `delete from project_holds where project_id=?`, projectID)
	if err != nil {
		return Project{}, err
	}
	if _, err = rowsAffectedOrProjectExists(ctx, s, res, projectID); err != nil {
		return Project{}, err
	}
	return s.GetProject(ctx, projectID)
}

func (s *Store) ListHeldProjectsDue(ctx context.Context, dueAt string) ([]Project, error) {
	rows, err := s.db.QueryContext(ctx, projectSelect+`
		where h.project_id is not null and (h.next_check_at='' or h.next_check_at<=?)
		order by h.next_check_at asc, h.hold_since asc`, dueAt)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	projects := []Project{}
	for rows.Next() {
		p, err := scanProject(rows)
		if err != nil {
			return nil, err
		}
		projects = append(projects, p)
	}
	return projects, rows.Err()
}

func (s *Store) ListHeldProjects(ctx context.Context) ([]Project, error) {
	rows, err := s.db.QueryContext(ctx, projectSelect+`
		where h.project_id is not null order by h.hold_since asc, p.id asc`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	projects := []Project{}
	for rows.Next() {
		p, err := scanProject(rows)
		if err != nil {
			return nil, err
		}
		projects = append(projects, p)
	}
	return projects, rows.Err()
}

func (s *Store) UpdateProjectHoldCheck(ctx context.Context, projectID, checkedAt, nextCheckAt, errText string) (Project, error) {
	res, err := s.db.ExecContext(ctx, `update project_holds set last_check_at=?,
		next_check_at=?, last_check_error=?, updated_at=? where project_id=?`,
		checkedAt, nextCheckAt, errText, now(), projectID)
	if err != nil {
		return Project{}, err
	}
	if _, err = rowsAffectedOrProjectExists(ctx, s, res, projectID); err != nil {
		return Project{}, err
	}
	return s.GetProject(ctx, projectID)
}

func rowsAffectedOrProjectExists(ctx context.Context, st *Store, res sql.Result, projectID string) (int64, error) {
	n, err := res.RowsAffected()
	if err != nil {
		return 0, err
	}
	if n > 0 {
		return n, nil
	}
	if _, err = st.GetProject(ctx, projectID); errors.Is(err, ErrNotFound) {
		return 0, ErrNotFound
	}
	return 0, nil
}
