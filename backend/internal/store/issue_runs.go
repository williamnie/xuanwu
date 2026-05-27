package store

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
)

func (s *Store) ListIssueRuns(ctx context.Context, issueID int64) ([]IssueRun, error) {
	rows, err := s.db.QueryContext(ctx, `select id, issue_id, attempt, status,
		provider, provider_session_id, provider_turn_id, codex_thread_id,
		codex_turn_id, started_at, ended_at, exit_reason, error, agent_profile_id,
		capability_summary, selection_reason
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

func (s *Store) withLatestIssueRuns(ctx context.Context, issues []Issue) ([]Issue, error) {
	if len(issues) == 0 {
		return issues, nil
	}
	args := issueRunIDArgs(issues)
	query := latestIssueRunsQuery(len(args))
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	latest, err := scanLatestIssueRuns(rows)
	if err != nil {
		return nil, err
	}
	for idx := range issues {
		if run, ok := latest[issues[idx].ID]; ok {
			issues[idx].LatestRun = &run
		}
	}
	return issues, nil
}

func latestIssueRunsQuery(count int) string {
	placeholders := strings.TrimRight(strings.Repeat("?,", count), ",")
	return `select ir.id, ir.issue_id, ir.attempt, ir.status,
		ir.provider, ir.provider_session_id, ir.provider_turn_id,
		ir.codex_thread_id, ir.codex_turn_id, ir.started_at, ir.ended_at,
		ir.exit_reason, ir.error, ir.agent_profile_id, ir.capability_summary,
		ir.selection_reason from issue_runs ir
		join (select issue_id, max(attempt) as attempt from issue_runs
		where issue_id in (` + placeholders + `) group by issue_id) latest
		on latest.issue_id=ir.issue_id and latest.attempt=ir.attempt`
}

func issueRunIDArgs(issues []Issue) []any {
	args := make([]any, 0, len(issues))
	for _, issue := range issues {
		args = append(args, issue.ID)
	}
	return args
}

func scanLatestIssueRuns(rows *sql.Rows) (map[int64]IssueRun, error) {
	runs := map[int64]IssueRun{}
	for rows.Next() {
		run, err := scanIssueRun(rows)
		if err != nil {
			return nil, err
		}
		runs[run.IssueID] = run
	}
	return runs, rows.Err()
}

func currentIssueAttempt(ctx context.Context, tx *sql.Tx, issueID int64) (int, error) {
	var attempt int
	err := tx.QueryRowContext(ctx, `select attempt_count from issues where id=?`, issueID).Scan(&attempt)
	return attempt, err
}

func createIssueRun(ctx context.Context, tx *sql.Tx, issueID int64, attempt int, startedAt string) error {
	meta, err := defaultIssueRunSelection(ctx, tx, issueID)
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `insert into issue_runs
		(id, issue_id, attempt, status, provider, started_at, agent_profile_id, selection_reason)
		values (?, ?, ?, ?, ?, ?, ?, ?)`,
		issueRunID(issueID, attempt), issueID, attempt, StatusInProgress,
		firstNonEmptyString(meta.ProviderID, ProviderCodex), startedAt,
		meta.ProfileID, meta.SelectionReason)
	return err
}

type issueRunSelectionDefaults struct {
	ProfileID       string
	ProviderID      string
	SelectionReason string
}

func defaultIssueRunSelection(ctx context.Context, tx *sql.Tx, issueID int64) (issueRunSelectionDefaults, error) {
	var meta issueRunSelectionDefaults
	err := tx.QueryRowContext(ctx, `select
		coalesce(nullif(i.agent_profile_id, ''), p.default_agent_profile_id),
		coalesce(ap.provider, p.provider),
		case
			when i.agent_profile_id<>'' then 'issue_override'
			when p.default_agent_profile_id<>'' then 'project_default'
			else 'provider_default'
		end
		from issues i join projects p on p.id=i.project_id
		left join agent_profiles ap on ap.id=coalesce(nullif(i.agent_profile_id, ''), p.default_agent_profile_id)
		where i.id=?`, issueID).
		Scan(&meta.ProfileID, &meta.ProviderID, &meta.SelectionReason)
	return meta, err
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
		provider=?, provider_session_id=?, provider_turn_id=?,
		codex_thread_id=?, codex_turn_id=?, ended_at=?, exit_reason=?, error=?
		where id=? and ended_at=''`,
		status, firstNonEmptyString(run.Provider, ProviderCodex),
		firstNonEmptyString(run.ProviderSessionID, issue.CodexThreadID),
		firstNonEmptyString(run.ProviderTurnID, issue.CodexTurnID),
		issue.CodexThreadID, issue.CodexTurnID, now(),
		exitReason, strings.TrimSpace(errText), run.ID)
	return err
}

func (s *Store) latestOpenIssueRun(ctx context.Context, issueID int64) (IssueRun, bool, error) {
	row := s.db.QueryRowContext(ctx, `select id, issue_id, attempt, status,
		provider, provider_session_id, provider_turn_id, codex_thread_id,
		codex_turn_id, started_at, ended_at, exit_reason, error, agent_profile_id,
		capability_summary, selection_reason
		from issue_runs where issue_id=? and ended_at='' order by attempt desc limit 1`, issueID)
	run, err := scanIssueRun(row)
	if err == sql.ErrNoRows {
		return IssueRun{}, false, nil
	}
	return run, err == nil, err
}

func (s *Store) UpdateOpenIssueRunSelection(
	ctx context.Context,
	issueID int64,
	providerID string,
	profileID string,
	capabilitySummary string,
	selectionReason string,
) error {
	_, err := s.db.ExecContext(ctx, `update issue_runs set
		provider=?, agent_profile_id=?, capability_summary=?, selection_reason=?
		where issue_id=? and ended_at=''`,
		firstNonEmptyString(providerID, ProviderCodex), strings.TrimSpace(profileID),
		strings.TrimSpace(capabilitySummary), strings.TrimSpace(selectionReason), issueID)
	return err
}

func (s *Store) UpdateOpenIssueRunRuntime(
	ctx context.Context,
	issueID int64,
	providerID string,
	providerSessionID string,
	providerTurnID string,
) error {
	_, err := s.db.ExecContext(ctx, `update issue_runs set
		provider=?, provider_session_id=?, provider_turn_id=?
		where issue_id=? and ended_at=''`,
		firstNonEmptyString(providerID, ProviderCodex), strings.TrimSpace(providerSessionID),
		strings.TrimSpace(providerTurnID), issueID)
	return err
}

func (s *Store) closeStaleIssueRuns(ctx context.Context, message string) error {
	_, err := s.db.ExecContext(ctx, `update issue_runs set status=?,
		provider=case when provider='' then ? else provider end,
		provider_session_id=case when provider_session_id='' then coalesce((select codex_thread_id from issues where issues.id=issue_runs.issue_id), provider_session_id) else provider_session_id end,
		provider_turn_id=case when provider_turn_id='' then coalesce((select codex_turn_id from issues where issues.id=issue_runs.issue_id), provider_turn_id) else provider_turn_id end,
		codex_thread_id=coalesce((select codex_thread_id from issues where issues.id=issue_runs.issue_id), codex_thread_id),
		codex_turn_id=coalesce((select codex_turn_id from issues where issues.id=issue_runs.issue_id), codex_turn_id),
		ended_at=?, exit_reason=?, error=? where ended_at=''
		and issue_id in (select id from issues where status=? and error=?)`,
		StatusFailed, ProviderCodex, now(), "service_restarted", message, StatusFailed, message)
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
	return status == StatusDone || status == StatusFailed ||
		status == StatusCancelled || status == StatusPendingVerification
}

func issueRunID(issueID int64, attempt int) string {
	return fmt.Sprintf("issue-%d-attempt-%d", issueID, attempt)
}

func firstNonEmptyString(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}
