package runner

import (
	"context"
	"encoding/json"

	"github.com/xiaobei/codex-issue-runner/backend/internal/events"
	"github.com/xiaobei/codex-issue-runner/backend/internal/store"
)

func (r *Runner) advanceNightlyBatches(ctx context.Context, issueID int64) {
	results, err := r.store.AdvanceNightlyBatchesForIssue(ctx, issueID)
	r.publishNightlyResults(ctx, issueID, results, err)
}

func (r *Runner) pauseNightlyBatches(ctx context.Context, issueID int64, reason string) {
	results, err := r.store.PauseNightlyBatchesForIssue(ctx, issueID, reason)
	r.publishNightlyResults(ctx, issueID, results, err)
}

func (r *Runner) publishNightlyResults(
	ctx context.Context,
	issueID int64,
	results []store.NightlyBatchAdvanceResult,
	err error,
) {
	if err != nil {
		r.bus.Publish(events.AppEvent{Type: "nightly_batch.error", IssueID: issueID, Error: err.Error()})
		return
	}
	for _, result := range results {
		r.publishNightlyBatchEvent(result)
		if result.PromotedIssue != nil {
			r.recordNightlyPromotion(ctx, *result.PromotedIssue)
			r.publishStatus(result.PromotedIssue.ID, store.StatusTodo)
			_ = r.StartProject(result.PromotedIssue.ProjectID)
		}
	}
}

func (r *Runner) publishNightlyBatchEvent(result store.NightlyBatchAdvanceResult) {
	payload, _ := json.Marshal(map[string]any{
		"batch_id":       result.Batch.ID,
		"status":         result.Batch.Status,
		"current_issue":  result.Batch.CurrentIssueID,
		"pause_reason":   result.Batch.PauseReason,
		"promoted_issue": promotedNightlyIssueID(result),
	})
	r.bus.Publish(events.AppEvent{
		Type: "nightly_batch.updated", ProjectID: result.Batch.ProjectID,
		Status: result.Batch.Status, Error: result.Batch.PauseReason, Payload: string(payload),
	})
}

func promotedNightlyIssueID(result store.NightlyBatchAdvanceResult) int64 {
	if result.PromotedIssue == nil {
		return 0
	}
	return result.PromotedIssue.ID
}

func (r *Runner) recordNightlyPromotion(ctx context.Context, issue store.Issue) {
	payload, _ := json.Marshal(map[string]string{"status": store.StatusTodo, "source": "nightly_batch"})
	e, err := r.store.AddIssueEvent(ctx, issue.ID, "issue.status_changed", string(payload))
	if err != nil {
		return
	}
	r.bus.Publish(events.AppEvent{
		ID: e.ID, Type: "issue.status_changed", IssueID: issue.ID,
		ProjectID: issue.ProjectID, Status: store.StatusTodo, CreatedAt: e.CreatedAt,
	})
}
