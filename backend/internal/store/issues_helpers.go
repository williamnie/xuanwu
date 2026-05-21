package store

import (
	"context"
	"database/sql"
	"errors"
	"strings"
)

const issueTitleMaxRunes = 50

var ErrIssueContentRequired = errors.New("issue 内容不能为空")

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

func normalizeIssueForCreate(issue *Issue) error {
	issue.Title = strings.TrimSpace(issue.Title)
	issue.Description = strings.TrimSpace(issue.Description)
	if issue.Title == "" {
		issue.Title = deriveIssueTitle(issue.Description)
	}
	if issue.Title == "" {
		return ErrIssueContentRequired
	}
	return nil
}

func deriveIssueTitle(content string) string {
	line := firstNonEmptyLine(content)
	return truncateRunes(line, issueTitleMaxRunes)
}

func firstNonEmptyLine(content string) string {
	for _, line := range strings.Split(content, "\n") {
		if text := strings.TrimSpace(line); text != "" {
			return text
		}
	}
	return ""
}

func truncateRunes(value string, maxRunes int) string {
	runes := []rune(value)
	if len(runes) <= maxRunes {
		return value
	}
	return string(runes[:maxRunes-1]) + "…"
}

func (s *Store) applyIssueTemplateSnapshot(ctx context.Context, issue *Issue) error {
	if strings.TrimSpace(issue.PromptTemplate) != "" {
		issue.PromptTemplate = strings.TrimSpace(issue.PromptTemplate)
		return nil
	}
	tmpl, err := s.issueTemplateForIssue(ctx, issue.TemplateID)
	if err != nil {
		return err
	}
	issue.TemplateID = tmpl.ID
	issue.PromptTemplate = tmpl.Content
	return nil
}
