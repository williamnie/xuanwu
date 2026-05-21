package store

import (
	"context"
	"database/sql"
)

func applyIssuePatch(i *Issue, patch IssuePatch) {
	if patch.Title != nil {
		i.Title = *patch.Title
	}
	if patch.Description != nil {
		i.Description = *patch.Description
	}
	if patch.Status != nil {
		i.Status = *patch.Status
	}
	if patch.Priority != nil {
		i.Priority = *patch.Priority
	}
	if patch.CodexThreadID != nil {
		i.CodexThreadID = *patch.CodexThreadID
	}
	if patch.CodexTurnID != nil {
		i.CodexTurnID = *patch.CodexTurnID
	}
	if patch.Error != nil {
		i.Error = *patch.Error
	}
}

func lastInsertID(ctx context.Context, db *sql.DB) (int64, error) {
	var id int64
	err := db.QueryRowContext(ctx, `select last_insert_rowid()`).Scan(&id)
	return id, err
}

func selectNextIssueID(ctx context.Context, tx *sql.Tx, projectID string) (int64, bool, error) {
	row := tx.QueryRowContext(ctx, `select id from issues where project_id=? and status=?
		order by priority desc, created_at asc limit 1`, projectID, StatusTodo)
	var id int64
	err := row.Scan(&id)
	if err == sql.ErrNoRows {
		return 0, false, nil
	}
	return id, err == nil, err
}
