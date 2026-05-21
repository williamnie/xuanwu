package store

import "context"

func (s *Store) AddIssueEvent(ctx context.Context, issueID int64, typ, payload string) (IssueEvent, error) {
	t := now()
	_, err := s.db.ExecContext(ctx, `insert into issue_events(issue_id, type, payload, created_at)
		values (?, ?, ?, ?)`, issueID, typ, payload, t)
	if err != nil {
		return IssueEvent{}, err
	}
	id, err := lastInsertID(ctx, s.db)
	if err != nil {
		return IssueEvent{}, err
	}
	return IssueEvent{ID: id, IssueID: issueID, Type: typ, Payload: payload, CreatedAt: t}, nil
}

func (s *Store) ListIssueEvents(ctx context.Context, issueID int64) ([]IssueEvent, error) {
	rows, err := s.db.QueryContext(ctx, `select id, issue_id, type, payload, created_at
		from issue_events where issue_id=? order by id asc`, issueID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	events := []IssueEvent{}
	for rows.Next() {
		e, err := scanIssueEvent(rows)
		if err != nil {
			return nil, err
		}
		events = append(events, e)
	}
	return events, rows.Err()
}
