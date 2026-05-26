package store

import "context"

type SessionCommandEventRecord struct {
	ID                int64  `json:"id"`
	Provider          string `json:"provider"`
	ProviderSessionID string `json:"provider_session_id"`
	CommandName       string `json:"command_name"`
	CommandArgsJSON   string `json:"command_args_json"`
	PromptSummary     string `json:"prompt_summary"`
	ReferencesSummary string `json:"references_summary"`
	ResultSummary     string `json:"result_summary"`
	TargetIssueID     int64  `json:"target_issue_id,omitempty"`
	CreatedIssueID    int64  `json:"created_issue_id,omitempty"`
	EnqueuedIssueID   int64  `json:"enqueued_issue_id,omitempty"`
	Error             string `json:"error,omitempty"`
	CreatedAt         string `json:"created_at"`
}

func (s *Store) SaveSessionCommandEvent(ctx context.Context, rec SessionCommandEventRecord) error {
	if rec.Provider == "" {
		rec.Provider = ProviderCodex
	}
	_, err := s.db.ExecContext(ctx, `insert into session_command_events
		(provider, provider_session_id, command_name, command_args_json,
		prompt_summary, references_summary, result_summary, target_issue_id,
		created_issue_id, enqueued_issue_id, error, created_at)
		values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		rec.Provider, rec.ProviderSessionID, rec.CommandName, rec.CommandArgsJSON,
		rec.PromptSummary, rec.ReferencesSummary, rec.ResultSummary, rec.TargetIssueID,
		rec.CreatedIssueID, rec.EnqueuedIssueID, rec.Error, now())
	return err
}

func (s *Store) ListSessionCommandEvents(ctx context.Context, sessionID string) ([]SessionCommandEventRecord, error) {
	rows, err := s.db.QueryContext(ctx, `select id, provider, provider_session_id,
		command_name, command_args_json, prompt_summary, references_summary,
		result_summary, target_issue_id, created_issue_id, enqueued_issue_id,
		error, created_at from session_command_events
		where provider_session_id=? order by id asc`, sessionID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	records := []SessionCommandEventRecord{}
	for rows.Next() {
		var rec SessionCommandEventRecord
		if err := rows.Scan(&rec.ID, &rec.Provider, &rec.ProviderSessionID,
			&rec.CommandName, &rec.CommandArgsJSON, &rec.PromptSummary,
			&rec.ReferencesSummary, &rec.ResultSummary, &rec.TargetIssueID,
			&rec.CreatedIssueID, &rec.EnqueuedIssueID, &rec.Error,
			&rec.CreatedAt); err != nil {
			return nil, err
		}
		records = append(records, rec)
	}
	return records, rows.Err()
}
