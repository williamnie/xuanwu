package store

import (
	"context"
	"database/sql"
	"errors"
)

func getNightlyBatch(ctx context.Context, db *sql.DB, id int64) (NightlyBatch, error) {
	batch, err := scanNightlyBatch(db.QueryRowContext(ctx, nightlyBatchSelect+` where id=?`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return NightlyBatch{}, ErrNotFound
	}
	return batch, err
}

func getNightlyBatchTx(ctx context.Context, tx *sql.Tx, id int64) (NightlyBatch, error) {
	batch, err := scanNightlyBatch(tx.QueryRowContext(ctx, nightlyBatchSelect+` where id=?`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return NightlyBatch{}, ErrNotFound
	}
	return batch, err
}

func issueForNightlyPromotion(ctx context.Context, tx *sql.Tx, issueID int64) (Issue, error) {
	issue, err := scanIssue(tx.QueryRowContext(ctx, issueSelect+` where id=?`, issueID))
	if errors.Is(err, sql.ErrNoRows) {
		return Issue{}, ErrNotFound
	}
	return issue, err
}

func (s *Store) listNightlyBatchItems(ctx context.Context, batchID int64) ([]NightlyBatchItem, error) {
	rows, err := s.db.QueryContext(ctx, `select batch_id, issue_id, position, status, updated_at
		from nightly_batch_items where batch_id=? order by position asc`, batchID)
	if err != nil {
		return nil, err
	}
	items := []NightlyBatchItem{}
	for rows.Next() {
		item, err := scanNightlyBatchItem(rows)
		if err != nil {
			rows.Close()
			return nil, err
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	for idx := range items {
		issue, err := s.GetIssue(ctx, items[idx].IssueID)
		if err == nil {
			items[idx].Issue = &issue
		}
	}
	return items, nil
}

func (s *Store) hydrateNightlyAdvanceResult(ctx context.Context, result NightlyBatchAdvanceResult) (NightlyBatchAdvanceResult, error) {
	if result.Batch.ID == 0 {
		return result, nil
	}
	batch, err := s.GetNightlyBatch(ctx, result.Batch.ID)
	if err != nil {
		return NightlyBatchAdvanceResult{}, err
	}
	result.Batch = batch
	if result.PromotedIssue == nil {
		return result, nil
	}
	issue, err := s.GetIssue(ctx, result.PromotedIssue.ID)
	if err != nil {
		return NightlyBatchAdvanceResult{}, err
	}
	result.PromotedIssue = &issue
	return result, nil
}

const nightlyBatchSelect = `select nightly_batches.id, nightly_batches.project_id,
	nightly_batches.policy, nightly_batches.promotion_mode, nightly_batches.status,
	nightly_batches.current_issue_id, nightly_batches.pause_reason,
	nightly_batches.created_at, nightly_batches.updated_at from nightly_batches`

func nightlyBatchTxResults(
	ctx context.Context,
	tx *sql.Tx,
	issueID int64,
	fn func(*sql.Tx, int64) (NightlyBatchAdvanceResult, error),
) ([]NightlyBatchAdvanceResult, error) {
	batchIDs, err := activeNightlyBatchIDsForIssue(ctx, tx, issueID)
	if err != nil {
		return nil, err
	}
	results := []NightlyBatchAdvanceResult{}
	for _, batchID := range batchIDs {
		result, err := fn(tx, batchID)
		if err != nil {
			return nil, err
		}
		if result.Batch.ID == batchID {
			results = append(results, result)
		}
	}
	return results, nil
}

func (s *Store) hydrateNightlyAdvanceResults(
	ctx context.Context,
	results []NightlyBatchAdvanceResult,
) ([]NightlyBatchAdvanceResult, error) {
	var err error
	for idx := range results {
		results[idx], err = s.hydrateNightlyAdvanceResult(ctx, results[idx])
		if err != nil {
			return nil, err
		}
	}
	return results, nil
}
