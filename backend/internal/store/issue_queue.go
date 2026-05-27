package store

import (
	"context"
	"database/sql"
	"strings"
)

func (s *Store) PromoteTriageToTodo(ctx context.Context, projectID string) ([]Issue, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	issues, err := selectTriageIssues(ctx, tx, projectID)
	if err != nil || len(issues) == 0 {
		return issues, err
	}
	updatedAt := now()
	for idx := range issues {
		if err := setIssueTodo(ctx, tx, issues[idx].ID, updatedAt); err != nil {
			return nil, err
		}
		issues[idx].Status = StatusTodo
		issues[idx].Error = ""
		issues[idx].UpdatedAt = updatedAt
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return issues, nil
}

func selectTriageIssues(ctx context.Context, tx *sql.Tx, projectID string) ([]Issue, error) {
	query, args := triageIssueQuery(projectID)
	rows, err := tx.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	issues := []Issue{}
	for rows.Next() {
		issue, err := scanIssue(rows)
		if err != nil {
			return nil, err
		}
		issues = append(issues, issue)
	}
	return issues, rows.Err()
}

func triageIssueQuery(projectID string) (string, []any) {
	conds := []string{"i.status=?", "h.project_id is null"}
	args := []any{StatusTriage}
	if projectID != "" {
		conds = append(conds, "i.project_id=?")
		args = append(args, projectID)
	}
	query := issueSelectWithAlias("i") + ` left join project_holds h on h.project_id=i.project_id where ` +
		strings.Join(conds, " and ") + ` order by i.priority desc, i.created_at asc, i.id asc`
	return query, args
}

func setIssueTodo(ctx context.Context, tx *sql.Tx, issueID int64, updatedAt string) error {
	var snapshot string
	if err := tx.QueryRowContext(ctx, `select workflow_snapshot_json from issues where id=?`, issueID).Scan(&snapshot); err != nil {
		return err
	}
	snapshot = nextWorkflowSnapshot(snapshot, StatusTodo, "", "system", "", updatedAt)
	_, err := tx.ExecContext(ctx, `update issues set status=?, error='',
		workflow_snapshot_json=?, updated_at=? where id=? and status=?`,
		StatusTodo, snapshot, updatedAt, issueID, StatusTriage)
	return err
}
