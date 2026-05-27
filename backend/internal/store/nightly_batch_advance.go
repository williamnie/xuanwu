package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
)

func promoteNextNightlyBatchIssueTx(ctx context.Context, tx *sql.Tx, batchID int64) (NightlyBatchAdvanceResult, error) {
	batch, err := getNightlyBatchTx(ctx, tx, batchID)
	if err != nil || batch.Status != NightlyBatchActive {
		return NightlyBatchAdvanceResult{Batch: batch}, err
	}
	stopped, result, err := stoppedNightlyPromotion(ctx, tx, batch)
	if stopped || err != nil {
		return result, err
	}
	return promotePendingNightlyItem(ctx, tx, batch)
}

func promotePendingNightlyItem(ctx context.Context, tx *sql.Tx, batch NightlyBatch) (NightlyBatchAdvanceResult, error) {
	item, err := nextPendingNightlyItem(ctx, tx, batch.ID)
	if err != nil || item.IssueID == 0 {
		if err != nil {
			return NightlyBatchAdvanceResult{}, err
		}
		return finishNightlyBatchTx(ctx, tx, batch.ID)
	}
	return promoteNightlyItemAndReload(ctx, tx, batch, item)
}

func stoppedNightlyPromotion(ctx context.Context, tx *sql.Tx, batch NightlyBatch) (bool, NightlyBatchAdvanceResult, error) {
	if paused, reason, err := nightlyBatchBlockReason(ctx, tx, batch); err != nil || paused {
		if err != nil {
			return false, NightlyBatchAdvanceResult{}, err
		}
		result, err := pauseNightlyBatchTx(ctx, tx, batch.ID, reason)
		return true, result, err
	}
	current, err := currentNightlyItem(ctx, tx, batch.ID)
	if err != nil || current.IssueID != 0 {
		return true, NightlyBatchAdvanceResult{Batch: batch}, err
	}
	return false, NightlyBatchAdvanceResult{}, nil
}

func promoteNightlyItemAndReload(
	ctx context.Context,
	tx *sql.Tx,
	batch NightlyBatch,
	item NightlyBatchItem,
) (NightlyBatchAdvanceResult, error) {
	issue, err := promoteNightlyItemTx(ctx, tx, batch, item)
	if err != nil {
		return NightlyBatchAdvanceResult{}, err
	}
	reloaded, err := getNightlyBatchTx(ctx, tx, batch.ID)
	if err != nil {
		return NightlyBatchAdvanceResult{}, err
	}
	return NightlyBatchAdvanceResult{Batch: reloaded, PromotedIssue: &issue}, nil
}

func advanceNightlyBatchForIssueTx(ctx context.Context, tx *sql.Tx, batchID int64, issue Issue) (NightlyBatchAdvanceResult, error) {
	batch, item, err := activeNightlyBatchItem(ctx, tx, batchID, issue.ID)
	if err != nil || batch.ID == 0 {
		return NightlyBatchAdvanceResult{}, err
	}
	status := nightlyItemStatusForIssue(issue.Status)
	if status == "" {
		return NightlyBatchAdvanceResult{Batch: batch}, nil
	}
	if err := updateNightlyItemStatus(ctx, tx, batch.ID, issue.ID, status); err != nil {
		return NightlyBatchAdvanceResult{}, err
	}
	if item.Status == NightlyItemCurrent && status == NightlyItemFailed && batch.Policy == NightlyPolicyFailStop {
		return pauseNightlyBatchTx(ctx, tx, batch.ID, fmt.Sprintf("issue #%d %s", issue.ID, issue.Status))
	}
	return promoteNextNightlyBatchIssueTx(ctx, tx, batch.ID)
}

func nightlyItemStatusForIssue(status string) string {
	switch status {
	case StatusDone:
		return NightlyItemDone
	case StatusFailed:
		return NightlyItemFailed
	case StatusCancelled:
		return NightlyItemSkipped
	}
	return ""
}

func promoteNightlyItemTx(ctx context.Context, tx *sql.Tx, batch NightlyBatch, item NightlyBatchItem) (Issue, error) {
	issue, err := issueForNightlyPromotion(ctx, tx, item.IssueID)
	if err != nil {
		return Issue{}, err
	}
	if err := ensureNightlyItemTriage(ctx, tx, batch.ID, item.IssueID, issue.Status); err != nil {
		return Issue{}, err
	}
	t := now()
	priority := nightlyPromotionPriority(item.Position)
	if err := updateIssueForNightlyPromotion(ctx, tx, issue, priority, t); err != nil {
		return Issue{}, err
	}
	if err := markNightlyItemCurrent(ctx, tx, batch.ID, item.IssueID, t); err != nil {
		return Issue{}, err
	}
	issue.Status = StatusTodo
	issue.Error = ""
	issue.Priority = priority
	issue.UpdatedAt = t
	return issue, nil
}

func ensureNightlyItemTriage(ctx context.Context, tx *sql.Tx, batchID, issueID int64, status string) error {
	if status == StatusTriage {
		return nil
	}
	if err := updateNightlyItemStatus(ctx, tx, batchID, issueID, nightlyStatusForExistingIssue(status)); err != nil {
		return err
	}
	return fmt.Errorf("issue #%d is %s, want triage", issueID, status)
}

func updateIssueForNightlyPromotion(ctx context.Context, tx *sql.Tx, issue Issue, priority int, t string) error {
	snapshot := nextWorkflowSnapshot(issue.WorkflowSnapshotJSON, StatusTodo, "", "system", "nightly batch", t)
	res, err := tx.ExecContext(ctx, `update issues set status=?, error='', priority=?,
		workflow_snapshot_json=?, updated_at=? where id=? and status=?`,
		StatusTodo, priority, snapshot, t, issue.ID, StatusTriage)
	if err != nil {
		return err
	}
	return requireAffected(res)
}

func markNightlyItemCurrent(ctx context.Context, tx *sql.Tx, batchID, issueID int64, t string) error {
	if err := updateNightlyItemStatus(ctx, tx, batchID, issueID, NightlyItemCurrent); err != nil {
		return err
	}
	_, err := tx.ExecContext(ctx, `update nightly_batches set current_issue_id=?, updated_at=? where id=?`, issueID, t, batchID)
	return err
}

const nightlyPriorityBase = 100000

func nightlyPromotionPriority(position int) int {
	return nightlyPriorityBase - position
}

func nightlyStatusForExistingIssue(status string) string {
	if mapped := nightlyItemStatusForIssue(status); mapped != "" {
		return mapped
	}
	return NightlyItemSkipped
}

func nightlyBatchBlockReason(ctx context.Context, tx *sql.Tx, batch NightlyBatch) (bool, string, error) {
	var message string
	err := tx.QueryRowContext(ctx, `select message from project_holds where project_id=?`, batch.ProjectID).Scan(&message)
	if errors.Is(err, sql.ErrNoRows) {
		return false, "", nil
	}
	if err != nil {
		return false, "", err
	}
	return true, message, nil
}

func pauseNightlyBatchTx(ctx context.Context, tx *sql.Tx, batchID int64, reason string) (NightlyBatchAdvanceResult, error) {
	t := now()
	_, err := tx.ExecContext(ctx, `update nightly_batches set status=?, pause_reason=?, updated_at=? where id=?`,
		NightlyBatchPaused, reason, t, batchID)
	if err != nil {
		return NightlyBatchAdvanceResult{}, err
	}
	batch, err := getNightlyBatchTx(ctx, tx, batchID)
	return NightlyBatchAdvanceResult{Batch: batch}, err
}

func finishNightlyBatchTx(ctx context.Context, tx *sql.Tx, batchID int64) (NightlyBatchAdvanceResult, error) {
	t := now()
	_, err := tx.ExecContext(ctx, `update nightly_batches set status=?, current_issue_id=0, updated_at=? where id=?`,
		NightlyBatchDone, t, batchID)
	if err != nil {
		return NightlyBatchAdvanceResult{}, err
	}
	batch, err := getNightlyBatchTx(ctx, tx, batchID)
	return NightlyBatchAdvanceResult{Batch: batch}, err
}

func currentNightlyItem(ctx context.Context, tx *sql.Tx, batchID int64) (NightlyBatchItem, error) {
	return queryNightlyItem(ctx, tx, `select batch_id, issue_id, position, status, updated_at
		from nightly_batch_items where batch_id=? and status=? order by position asc limit 1`,
		batchID, NightlyItemCurrent)
}

func nextPendingNightlyItem(ctx context.Context, tx *sql.Tx, batchID int64) (NightlyBatchItem, error) {
	return queryNightlyItem(ctx, tx, `select batch_id, issue_id, position, status, updated_at
		from nightly_batch_items where batch_id=? and status=? order by position asc limit 1`,
		batchID, NightlyItemPending)
}

func activeNightlyBatchItem(ctx context.Context, tx *sql.Tx, batchID, issueID int64) (NightlyBatch, NightlyBatchItem, error) {
	row := tx.QueryRowContext(ctx, nightlyBatchSelect+` join nightly_batch_items i on i.batch_id=nightly_batches.id
		where nightly_batches.id=? and i.issue_id=? and nightly_batches.status=? limit 1`,
		batchID, issueID, NightlyBatchActive)
	batch, err := scanNightlyBatch(row)
	if errors.Is(err, sql.ErrNoRows) {
		return NightlyBatch{}, NightlyBatchItem{}, nil
	}
	if err != nil {
		return NightlyBatch{}, NightlyBatchItem{}, err
	}
	item, err := queryNightlyItem(ctx, tx, `select batch_id, issue_id, position, status, updated_at
		from nightly_batch_items where batch_id=? and issue_id=?`, batch.ID, issueID)
	return batch, item, err
}

func activeNightlyBatchIDsForIssue(ctx context.Context, tx *sql.Tx, issueID int64) ([]int64, error) {
	rows, err := tx.QueryContext(ctx, `select b.id from nightly_batches b
		join nightly_batch_items i on i.batch_id=b.id
		where i.issue_id=? and b.status=? order by b.id asc`, issueID, NightlyBatchActive)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	ids := []int64{}
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

func queryNightlyItem(ctx context.Context, tx *sql.Tx, query string, args ...any) (NightlyBatchItem, error) {
	item, err := scanNightlyBatchItem(tx.QueryRowContext(ctx, query, args...))
	if errors.Is(err, sql.ErrNoRows) {
		return NightlyBatchItem{}, nil
	}
	return item, err
}

func updateNightlyItemStatus(ctx context.Context, tx *sql.Tx, batchID, issueID int64, status string) error {
	_, err := tx.ExecContext(ctx, `update nightly_batch_items set status=?, updated_at=? where batch_id=? and issue_id=?`,
		status, now(), batchID, issueID)
	return err
}
