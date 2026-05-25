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
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return s.withLatestIssueRuns(ctx, issues)
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
		prompt_template, source_session_id, source_turn_id, source_excerpt,
		created_at, updated_at)
		values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		i.ProjectID, i.Title, i.Description, i.Status, i.Priority,
		i.TemplateID, i.PromptTemplate, i.SourceSessionID, i.SourceTurnID,
		i.SourceExcerpt, t, t)
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
	if patch.Status != nil {
		i.AutoRetryNextAt = ""
		i.AutoRetryReason = ""
	}
	_, err = s.db.ExecContext(ctx, `update issues set title=?, description=?, status=?,
		priority=?, codex_thread_id=?, codex_turn_id=?, auto_retry_next_at=?,
		auto_retry_reason=?, error=?, updated_at=? where id=?`,
		i.Title, i.Description, i.Status, i.Priority, i.CodexThreadID,
		i.CodexTurnID, i.AutoRetryNextAt, i.AutoRetryReason, i.Error, now(), id)
	if err != nil {
		return Issue{}, err
	}
	if patch.Status != nil {
		if err := s.closeOpenIssueRun(ctx, id, i.Status, patchStatusExitReason(i.Status), i.Error); err != nil {
			return Issue{}, err
		}
	}
	return s.GetIssue(ctx, id)
}

func (s *Store) UpdateIssueClosingRunAs(
	ctx context.Context,
	id int64,
	patch IssuePatch,
	runStatus string,
	exitReason string,
	errText string,
) (Issue, error) {
	return s.UpdateIssueAndCloseRun(ctx, IssueRunClosePatch{
		IssueID: id, Patch: patch, RunStatus: runStatus, ExitReason: exitReason, Error: errText,
	})
}

func (s *Store) UpdateIssueAndCloseRun(ctx context.Context, req IssueRunClosePatch) (Issue, error) {
	id := req.IssueID
	i, err := s.GetIssue(ctx, id)
	if err != nil {
		return Issue{}, err
	}
	applyIssuePatch(&i, req.Patch)
	if req.Patch.Status != nil {
		i.AutoRetryNextAt = ""
		i.AutoRetryReason = ""
	}
	_, err = s.db.ExecContext(ctx, `update issues set title=?, description=?, status=?,
		priority=?, codex_thread_id=?, codex_turn_id=?, auto_retry_next_at=?,
		auto_retry_reason=?, error=?, updated_at=? where id=?`,
		i.Title, i.Description, i.Status, i.Priority, i.CodexThreadID,
		i.CodexTurnID, i.AutoRetryNextAt, i.AutoRetryReason, i.Error, now(), id)
	if err != nil {
		return Issue{}, err
	}
	if req.Patch.Status != nil {
		if err := s.closeOpenIssueRun(ctx, id, req.RunStatus, req.ExitReason, req.Error); err != nil {
			return Issue{}, err
		}
	}
	return s.GetIssue(ctx, id)
}

func (s *Store) ClaimNextIssue(ctx context.Context, projectID string) (Issue, bool, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return Issue{}, false, err
	}
	defer tx.Rollback()
	t := now()
	id, ok, err := selectNextIssueID(ctx, tx, projectID, t)
	if err != nil || !ok {
		return Issue{}, ok, err
	}
	_, err = tx.ExecContext(ctx, `update issues set status=?, attempt_count=attempt_count+1,
		auto_retry_next_at='', auto_retry_reason='', error='', updated_at=?
		where id=? and status=?`, StatusInProgress, t, id, StatusTodo)
	if err != nil {
		return Issue{}, false, err
	}
	attempt, err := currentIssueAttempt(ctx, tx, id)
	if err != nil {
		return Issue{}, false, err
	}
	if err := createIssueRun(ctx, tx, id, attempt, t); err != nil {
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
	if err != nil {
		return err
	}
	_, err = s.db.ExecContext(ctx, `update issue_runs set provider=?,
		provider_session_id=?, provider_turn_id=?, codex_thread_id=?,
		codex_turn_id=? where issue_id=? and ended_at=''`,
		ProviderCodex, threadID, turnID, threadID, turnID, id)
	return err
}

func (s *Store) ListIssueThreadIDs(ctx context.Context) (map[string]bool, error) {
	rows, err := s.db.QueryContext(ctx, `select distinct codex_thread_id from issues where codex_thread_id<>''`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	ids := map[string]bool{}
	for rows.Next() {
		var threadID string
		if err := rows.Scan(&threadID); err != nil {
			return nil, err
		}
		ids[threadID] = true
	}
	return ids, rows.Err()
}

func (s *Store) SetIssueStatus(ctx context.Context, id int64, status, errText string) (Issue, error) {
	_, err := s.db.ExecContext(ctx, `update issues set status=?, error=?,
		auto_retry_next_at='', auto_retry_reason='', updated_at=? where id=?`,
		status, errText, now(), id)
	if err != nil {
		return Issue{}, err
	}
	if err := s.closeOpenIssueRun(ctx, id, status, issueStatusExitReason(status, errText), errText); err != nil {
		return Issue{}, err
	}
	return s.GetIssue(ctx, id)
}

func (s *Store) ScheduleIssueAutoRetry(ctx context.Context, id int64, reason, nextAt string) (Issue, error) {
	res, err := s.db.ExecContext(ctx, `update issues set status=?, error='',
		auto_retry_next_at=?, auto_retry_reason=?, updated_at=?
		where id=? and status=?`, StatusTodo, nextAt, reason, now(), id, StatusInProgress)
	if err != nil {
		return Issue{}, err
	}
	if err := requireAffected(res); err != nil {
		return Issue{}, err
	}
	if err := s.closeOpenIssueRun(ctx, id, "auto_retry", "auto_retry_scheduled", reason); err != nil {
		return Issue{}, err
	}
	return s.GetIssue(ctx, id)
}

func (s *Store) ResetIssueForRunnerHold(ctx context.Context, id int64, message string) (Issue, error) {
	_, err := s.db.ExecContext(ctx, `update issues set status=?, error=?,
		auto_retry_next_at='', auto_retry_reason='', updated_at=?
		where id=? and status=?`, StatusTodo, message, now(), id, StatusInProgress)
	if err != nil {
		return Issue{}, err
	}
	if err := s.closeOpenIssueRun(ctx, id, "hold", "hold", message); err != nil {
		return Issue{}, err
	}
	return s.GetIssue(ctx, id)
}

func (s *Store) FailStaleIssues(ctx context.Context) error {
	message := "Service restarted while issue was in progress"
	_, err := s.db.ExecContext(ctx, `update issues set status=?, error=?,
		auto_retry_next_at='', auto_retry_reason='', updated_at=? where status=?`,
		StatusFailed, message, now(), StatusInProgress)
	if err != nil {
		return err
	}
	return s.closeStaleIssueRuns(ctx, message)
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
	if sourceSessionID := normalizeIssueSourceSessionID(f.SourceSessionID); sourceSessionID != "" {
		conds, args = append(conds, "source_session_id = ?"), append(args, sourceSessionID)
	}
	if len(conds) > 0 {
		parts = append(parts, "where "+strings.Join(conds, " and "))
	}
	parts = append(parts, `order by priority desc, created_at asc`)
	return strings.Join(parts, " "), args
}

const issueSelect = `select id, project_id, title, description, status, priority,
	template_id, prompt_template, source_session_id, source_turn_id, source_excerpt,
	codex_thread_id, codex_turn_id, attempt_count,
	(select count(*) from issue_events where issue_id=issues.id and type='issue.comment') as comment_count,
	auto_retry_next_at, auto_retry_reason, error, created_at, updated_at from issues`

func issueSelectWithAlias(alias string) string {
	prefix := alias + "."
	return `select ` + prefix + `id, ` + prefix + `project_id, ` + prefix + `title,
		` + prefix + `description, ` + prefix + `status, ` + prefix + `priority,
		` + prefix + `template_id, ` + prefix + `prompt_template,
		` + prefix + `source_session_id, ` + prefix + `source_turn_id,
		` + prefix + `source_excerpt, ` + prefix + `codex_thread_id, ` + prefix + `codex_turn_id,
		` + prefix + `attempt_count, (select count(*) from issue_events
		where issue_id=` + prefix + `id and type='issue.comment') as comment_count,
		` + prefix + `auto_retry_next_at,
		` + prefix + `auto_retry_reason, ` + prefix + `error, ` + prefix + `created_at,
		` + prefix + `updated_at from issues ` + alias
}
