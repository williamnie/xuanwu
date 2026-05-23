package store

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
)

func (s *Store) ListIssueRuns(ctx context.Context, issueID int64) ([]IssueRun, error) {
	rows, err := s.db.QueryContext(ctx, `select id, issue_id, attempt, status,
		codex_thread_id, codex_turn_id, started_at, ended_at, exit_reason, error
		from issue_runs where issue_id=? order by attempt asc`, issueID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	runs := []IssueRun{}
	for rows.Next() {
		run, err := scanIssueRun(rows)
		if err != nil {
			return nil, err
		}
		runs = append(runs, run)
	}
	return runs, rows.Err()
}

func currentIssueAttempt(ctx context.Context, tx *sql.Tx, issueID int64) (int, error) {
	var attempt int
	err := tx.QueryRowContext(ctx, `select attempt_count from issues where id=?`, issueID).Scan(&attempt)
	return attempt, err
}

func createIssueRun(ctx context.Context, tx *sql.Tx, issueID int64, attempt int, startedAt string) error {
	_, err := tx.ExecContext(ctx, `insert into issue_runs
		(id, issue_id, attempt, status, started_at)
		values (?, ?, ?, ?, ?)`,
		issueRunID(issueID, attempt), issueID, attempt, StatusInProgress, startedAt)
	return err
}

func (s *Store) closeOpenIssueRun(
	ctx context.Context,
	issueID int64,
	status string,
	exitReason string,
	errText string,
) error {
	run, ok, err := s.latestOpenIssueRun(ctx, issueID)
	if err != nil || !ok {
		return err
	}
	issue, err := s.GetIssue(ctx, issueID)
	if err != nil {
		return err
	}
	_, err = s.db.ExecContext(ctx, `update issue_runs set status=?,
		codex_thread_id=?, codex_turn_id=?, ended_at=?, exit_reason=?, error=?
		where id=? and ended_at=''`,
		status, issue.CodexThreadID, issue.CodexTurnID, now(),
		exitReason, strings.TrimSpace(errText), run.ID)
	return err
}

func (s *Store) latestOpenIssueRun(ctx context.Context, issueID int64) (IssueRun, bool, error) {
	row := s.db.QueryRowContext(ctx, `select id, issue_id, attempt, status,
		codex_thread_id, codex_turn_id, started_at, ended_at, exit_reason, error
		from issue_runs where issue_id=? and ended_at='' order by attempt desc limit 1`, issueID)
	run, err := scanIssueRun(row)
	if err == sql.ErrNoRows {
		return IssueRun{}, false, nil
	}
	return run, err == nil, err
}

func (s *Store) closeStaleIssueRuns(ctx context.Context, message string) error {
	_, err := s.db.ExecContext(ctx, `update issue_runs set status=?,
		codex_thread_id=coalesce((select codex_thread_id from issues where issues.id=issue_runs.issue_id), codex_thread_id),
		codex_turn_id=coalesce((select codex_turn_id from issues where issues.id=issue_runs.issue_id), codex_turn_id),
		ended_at=?, exit_reason=?, error=? where ended_at=''
		and issue_id in (select id from issues where status=? and error=?)`,
		StatusFailed, now(), "service_restarted", message, StatusFailed, message)
	return err
}

func patchStatusExitReason(status string) string {
	if isTerminalIssueStatus(status) {
		return "explicit_status_update"
	}
	return "status_changed"
}

func issueStatusExitReason(status string, errText string) string {
	if strings.Contains(errText, "explicit issue status update") {
		return "missing_explicit_update"
	}
	switch status {
	case StatusDone:
		return "explicit_status_update"
	case StatusFailed:
		return "failed"
	case StatusCancelled:
		return "cancelled"
	default:
		return "status_changed"
	}
}

func isTerminalIssueStatus(status string) bool {
	return status == StatusDone || status == StatusFailed || status == StatusCancelled
}

func issueRunID(issueID int64, attempt int) string {
	return fmt.Sprintf("issue-%d-attempt-%d", issueID, attempt)
}
