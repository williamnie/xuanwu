package store

import (
	"context"
	"database/sql"
	"errors"
	"strings"
)

func (s *Store) ListIssues(ctx context.Context, f IssueFilter) ([]Issue, error) {
	query, args := issueListQuery(f)
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	issues := []Issue{}
	for rows.Next() {
		i, err := scanIssue(rows)
		if err != nil {
			return nil, err
		}
		issues = append(issues, i)
	}
	return issues, rows.Err()
}

func (s *Store) CreateIssue(ctx context.Context, i Issue) (Issue, error) {
	t := now()
	if i.Status == "" {
		i.Status = StatusTriage
	}
	if err := normalizeIssueForCreate(&i); err != nil {
		return Issue{}, err
	}
	if err := s.applyIssueTemplateSnapshot(ctx, &i); err != nil {
		return Issue{}, err
	}
	_, err := s.db.ExecContext(ctx, `insert into issues
		(project_id, title, description, status, priority, template_id,
		prompt_template, created_at, updated_at)
		values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		i.ProjectID, i.Title, i.Description, i.Status, i.Priority,
		i.TemplateID, i.PromptTemplate, t, t)
	if err != nil {
		return Issue{}, err
	}
	id, err := lastInsertID(ctx, s.db)
	if err != nil {
		return Issue{}, err
	}
	return s.GetIssue(ctx, id)
}

func (s *Store) GetIssue(ctx context.Context, id int64) (Issue, error) {
	row := s.db.QueryRowContext(ctx, issueSelect+` where id = ?`, id)
	i, err := scanIssue(row)
	if errors.Is(err, sql.ErrNoRows) {
		return Issue{}, ErrNotFound
	}
	return i, err
}

func (s *Store) UpdateIssue(ctx context.Context, id int64, patch IssuePatch) (Issue, error) {
	i, err := s.GetIssue(ctx, id)
	if err != nil {
		return Issue{}, err
	}
	applyIssuePatch(&i, patch)
	_, err = s.db.ExecContext(ctx, `update issues set title=?, description=?, status=?,
		priority=?, codex_thread_id=?, codex_turn_id=?, error=?, updated_at=? where id=?`,
		i.Title, i.Description, i.Status, i.Priority, i.CodexThreadID,
		i.CodexTurnID, i.Error, now(), id)
	if err != nil {
		return Issue{}, err
	}
	return s.GetIssue(ctx, id)
}

func (s *Store) ClaimNextIssue(ctx context.Context, projectID string) (Issue, bool, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return Issue{}, false, err
	}
	defer tx.Rollback()
	id, ok, err := selectNextIssueID(ctx, tx, projectID)
	if err != nil || !ok {
		return Issue{}, ok, err
	}
	_, err = tx.ExecContext(ctx, `update issues set status=?, attempt_count=attempt_count+1,
		error='', updated_at=? where id=? and status=?`, StatusInProgress, now(), id, StatusTodo)
	if err != nil {
		return Issue{}, false, err
	}
	if err := tx.Commit(); err != nil {
		return Issue{}, false, err
	}
	i, err := s.GetIssue(ctx, id)
	return i, true, err
}

func (s *Store) UpdateIssueRuntime(ctx context.Context, id int64, threadID, turnID string) error {
	_, err := s.db.ExecContext(ctx, `update issues set codex_thread_id=?,
		codex_turn_id=?, updated_at=? where id=?`, threadID, turnID, now(), id)
	return err
}

func (s *Store) SetIssueStatus(ctx context.Context, id int64, status, errText string) (Issue, error) {
	_, err := s.db.ExecContext(ctx, `update issues set status=?, error=?, updated_at=? where id=?`,
		status, errText, now(), id)
	if err != nil {
		return Issue{}, err
	}
	return s.GetIssue(ctx, id)
}

func (s *Store) FailStaleIssues(ctx context.Context) error {
	_, err := s.db.ExecContext(ctx, `update issues set status=?, error=?, updated_at=? where status=?`,
		StatusFailed, "Service restarted while issue was in progress", now(), StatusInProgress)
	return err
}

func issueListQuery(f IssueFilter) (string, []any) {
	parts := []string{issueSelect}
	conds, args := []string{}, []any{}
	if f.ProjectID != "" {
		conds, args = append(conds, "project_id = ?"), append(args, f.ProjectID)
	}
	if f.Status != "" {
		conds, args = append(conds, "status = ?"), append(args, f.Status)
	}
	if len(conds) > 0 {
		parts = append(parts, "where "+strings.Join(conds, " and "))
	}
	parts = append(parts, `order by priority desc, created_at asc`)
	return strings.Join(parts, " "), args
}

const issueSelect = `select id, project_id, title, description, status, priority,
	template_id, prompt_template, codex_thread_id, codex_turn_id, attempt_count,
	error, created_at, updated_at from issues`
