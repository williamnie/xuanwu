package store

import (
	"context"
	"database/sql"
	"errors"
	"strings"
)

func (s *Store) GetIssueByCodexThreadID(ctx context.Context, threadID string) (Issue, error) {
	threadID = strings.TrimSpace(threadID)
	if threadID == "" {
		return Issue{}, ErrNotFound
	}
	row := s.db.QueryRowContext(ctx, issueSelect+`
		where codex_thread_id = ?
		order by id desc
		limit 1`, threadID)
	issue, err := scanIssue(row)
	if errors.Is(err, sql.ErrNoRows) {
		return Issue{}, ErrNotFound
	}
	return issue, err
}
