package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
)

func (s *Store) CreateNightlyBatch(ctx context.Context, input NightlyBatchInput) (NightlyBatch, error) {
	input = normalizeNightlyBatchInput(input)
	if err := validateNightlyBatchInput(input); err != nil {
		return NightlyBatch{}, err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return NightlyBatch{}, err
	}
	defer tx.Rollback()
	batchID, err := createNightlyBatchTx(ctx, tx, input)
	if err != nil {
		return NightlyBatch{}, err
	}
	if err := tx.Commit(); err != nil {
		return NightlyBatch{}, err
	}
	return s.GetNightlyBatch(ctx, batchID)
}

func createNightlyBatchTx(ctx context.Context, tx *sql.Tx, input NightlyBatchInput) (int64, error) {
	if err := validateNightlyBatchIssues(ctx, tx, input); err != nil {
		return 0, err
	}
	createdAt := now()
	res, err := tx.ExecContext(ctx, `insert into nightly_batches
		(project_id, policy, promotion_mode, status, created_at, updated_at)
		values (?, ?, ?, ?, ?, ?)`, input.ProjectID, input.Policy,
		input.PromotionMode, NightlyBatchActive, createdAt, createdAt)
	if err != nil {
		return 0, err
	}
	batchID, err := res.LastInsertId()
	if err != nil {
		return 0, err
	}
	return batchID, insertNightlyBatchItems(ctx, tx, batchID, input.IssueIDs, createdAt)
}

func insertNightlyBatchItems(ctx context.Context, tx *sql.Tx, batchID int64, issueIDs []int64, createdAt string) error {
	for index, issueID := range issueIDs {
		_, err := tx.ExecContext(ctx, `insert into nightly_batch_items
			(batch_id, issue_id, position, status, updated_at) values (?, ?, ?, ?, ?)`,
			batchID, issueID, index+1, NightlyItemPending, createdAt)
		if err != nil {
			return err
		}
	}
	return nil
}

func (s *Store) ListNightlyBatches(ctx context.Context, projectID string) ([]NightlyBatch, error) {
	parts := []string{nightlyBatchSelect}
	args := []any{}
	if strings.TrimSpace(projectID) != "" {
		parts = append(parts, "where project_id=?")
		args = append(args, strings.TrimSpace(projectID))
	}
	parts = append(parts, "order by id desc")
	rows, err := s.db.QueryContext(ctx, strings.Join(parts, " "), args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	batches := []NightlyBatch{}
	for rows.Next() {
		batch, err := scanNightlyBatch(rows)
		if err != nil {
			return nil, err
		}
		batches = append(batches, batch)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	for idx := range batches {
		items, err := s.listNightlyBatchItems(ctx, batches[idx].ID)
		if err != nil {
			return nil, err
		}
		batches[idx].Items = items
	}
	return batches, nil
}

func (s *Store) GetNightlyBatch(ctx context.Context, id int64) (NightlyBatch, error) {
	batch, err := getNightlyBatch(ctx, s.db, id)
	if err != nil {
		return NightlyBatch{}, err
	}
	items, err := s.listNightlyBatchItems(ctx, id)
	if err != nil {
		return NightlyBatch{}, err
	}
	batch.Items = items
	return batch, nil
}

func (s *Store) PromoteNextNightlyBatchIssue(ctx context.Context, batchID int64) (NightlyBatchAdvanceResult, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return NightlyBatchAdvanceResult{}, err
	}
	defer tx.Rollback()
	result, err := promoteNextNightlyBatchIssueTx(ctx, tx, batchID)
	if err != nil {
		return NightlyBatchAdvanceResult{}, err
	}
	if err := tx.Commit(); err != nil {
		return NightlyBatchAdvanceResult{}, err
	}
	return s.hydrateNightlyAdvanceResult(ctx, result)
}

func (s *Store) AdvanceNightlyBatchesForIssue(ctx context.Context, issueID int64) ([]NightlyBatchAdvanceResult, error) {
	issue, err := s.GetIssue(ctx, issueID)
	if err != nil {
		return nil, err
	}
	return s.withNightlyBatchTx(ctx, issueID, func(tx *sql.Tx, batchID int64) (NightlyBatchAdvanceResult, error) {
		return advanceNightlyBatchForIssueTx(ctx, tx, batchID, issue)
	})
}

func (s *Store) PauseNightlyBatchesForIssue(ctx context.Context, issueID int64, reason string) ([]NightlyBatchAdvanceResult, error) {
	return s.withNightlyBatchTx(ctx, issueID, func(tx *sql.Tx, batchID int64) (NightlyBatchAdvanceResult, error) {
		return pauseNightlyBatchTx(ctx, tx, batchID, reason)
	})
}

func (s *Store) withNightlyBatchTx(
	ctx context.Context,
	issueID int64,
	fn func(*sql.Tx, int64) (NightlyBatchAdvanceResult, error),
) ([]NightlyBatchAdvanceResult, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	results, err := nightlyBatchTxResults(ctx, tx, issueID, fn)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return s.hydrateNightlyAdvanceResults(ctx, results)
}

func normalizeNightlyBatchInput(input NightlyBatchInput) NightlyBatchInput {
	input.ProjectID = strings.TrimSpace(input.ProjectID)
	if input.Policy == "" {
		input.Policy = NightlyPolicyFailStop
	}
	if input.PromotionMode == "" {
		input.PromotionMode = NightlyPromotionAuto
	}
	return input
}

func validateNightlyBatchInput(input NightlyBatchInput) error {
	if input.ProjectID == "" {
		return errors.New("project_id 不能为空")
	}
	if len(input.IssueIDs) == 0 {
		return errors.New("nightly batch 至少需要一个 issue")
	}
	if input.Policy != NightlyPolicyFailStop && input.Policy != NightlyPolicyContinue {
		return fmt.Errorf("unsupported nightly policy: %s", input.Policy)
	}
	if input.PromotionMode != NightlyPromotionAuto && input.PromotionMode != NightlyPromotionManual {
		return fmt.Errorf("unsupported promotion mode: %s", input.PromotionMode)
	}
	seen := map[int64]bool{}
	for _, id := range input.IssueIDs {
		if id <= 0 {
			return errors.New("issue id 不合法")
		}
		if seen[id] {
			return fmt.Errorf("issue #%d 重复", id)
		}
		seen[id] = true
	}
	return nil
}

func validateNightlyBatchIssues(ctx context.Context, tx *sql.Tx, input NightlyBatchInput) error {
	for _, issueID := range input.IssueIDs {
		var projectID, status string
		err := tx.QueryRowContext(ctx, `select project_id, status from issues where id=?`, issueID).
			Scan(&projectID, &status)
		if errors.Is(err, sql.ErrNoRows) {
			return ErrNotFound
		}
		if err != nil {
			return err
		}
		if projectID != input.ProjectID {
			return fmt.Errorf("issue #%d 不属于项目 %s", issueID, input.ProjectID)
		}
		if status != StatusTriage {
			return fmt.Errorf("issue #%d 不是 triage 状态", issueID)
		}
	}
	return nil
}
