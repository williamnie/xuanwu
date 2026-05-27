package store

import (
	"context"
	"strings"
	"testing"
)

func TestNightlyBatchPromotesOneIssueAtATime(t *testing.T) {
	st := openTestStore(t)
	ctx := context.Background()
	_, _ = st.CreateProject(ctx, Project{ID: "demo", Name: "Demo", CWD: t.TempDir()})
	first, _ := st.CreateIssue(ctx, Issue{ProjectID: "demo", Title: "first", Status: StatusTriage})
	second, _ := st.CreateIssue(ctx, Issue{ProjectID: "demo", Title: "second", Status: StatusTriage})

	batch, err := st.CreateNightlyBatch(ctx, NightlyBatchInput{
		ProjectID: "demo", IssueIDs: []int64{first.ID, second.ID},
		Policy: NightlyPolicyFailStop, PromotionMode: NightlyPromotionAuto,
	})
	if err != nil {
		t.Fatalf("create batch: %v", err)
	}
	if len(batch.Items) != 2 || batch.Items[0].IssueID != first.ID || batch.Items[1].IssueID != second.ID {
		t.Fatalf("batch order not persisted: %+v", batch.Items)
	}

	result, err := st.PromoteNextNightlyBatchIssue(ctx, batch.ID)
	if err != nil {
		t.Fatalf("promote first: %v", err)
	}
	if result.PromotedIssue == nil || result.PromotedIssue.ID != first.ID {
		t.Fatalf("promoted = %+v, want first issue", result.PromotedIssue)
	}
	gotFirst, _ := st.GetIssue(ctx, first.ID)
	gotSecond, _ := st.GetIssue(ctx, second.ID)
	if gotFirst.Status != StatusTodo || gotSecond.Status != StatusTriage {
		t.Fatalf("expected one todo at a time: first=%s second=%s", gotFirst.Status, gotSecond.Status)
	}

	claimed, ok, err := st.ClaimNextIssue(ctx, "demo")
	if err != nil || !ok || claimed.ID != first.ID {
		t.Fatalf("claim order: ok=%v issue=%+v err=%v", ok, claimed, err)
	}
	if _, err := st.SetIssueStatus(ctx, first.ID, StatusDone, ""); err != nil {
		t.Fatalf("complete first: %v", err)
	}
	results, err := st.AdvanceNightlyBatchesForIssue(ctx, first.ID)
	if err != nil {
		t.Fatalf("advance after done: %v", err)
	}
	if len(results) != 1 || results[0].PromotedIssue == nil || results[0].PromotedIssue.ID != second.ID {
		t.Fatalf("advance result = %+v, want second promoted", results)
	}
	gotSecond, _ = st.GetIssue(ctx, second.ID)
	if gotSecond.Status != StatusTodo {
		t.Fatalf("second status = %s, want todo", gotSecond.Status)
	}
}

func TestNightlyBatchFailStopPausesAfterFailedIssue(t *testing.T) {
	st := openTestStore(t)
	ctx := context.Background()
	_, _ = st.CreateProject(ctx, Project{ID: "demo", Name: "Demo", CWD: t.TempDir()})
	first, _ := st.CreateIssue(ctx, Issue{ProjectID: "demo", Title: "first", Status: StatusTriage})
	second, _ := st.CreateIssue(ctx, Issue{ProjectID: "demo", Title: "second", Status: StatusTriage})
	batch, err := st.CreateNightlyBatch(ctx, NightlyBatchInput{
		ProjectID: "demo", IssueIDs: []int64{first.ID, second.ID}, Policy: NightlyPolicyFailStop,
	})
	if err != nil {
		t.Fatalf("create batch: %v", err)
	}
	if _, err := st.PromoteNextNightlyBatchIssue(ctx, batch.ID); err != nil {
		t.Fatalf("promote first: %v", err)
	}
	if _, err := st.SetIssueStatus(ctx, first.ID, StatusFailed, "boom"); err != nil {
		t.Fatalf("fail first: %v", err)
	}

	if _, err := st.AdvanceNightlyBatchesForIssue(ctx, first.ID); err != nil {
		t.Fatalf("advance after failed: %v", err)
	}
	gotBatch, _ := st.GetNightlyBatch(ctx, batch.ID)
	if gotBatch.Status != NightlyBatchPaused || !strings.Contains(gotBatch.PauseReason, "failed") {
		t.Fatalf("batch should pause on failed issue: %+v", gotBatch)
	}
	gotSecond, _ := st.GetIssue(ctx, second.ID)
	if gotSecond.Status != StatusTriage {
		t.Fatalf("second issue should remain triage: %+v", gotSecond)
	}
	if gotBatch.Items[0].Status != NightlyItemFailed || gotBatch.Items[1].Status != NightlyItemPending {
		t.Fatalf("item statuses not recorded: %+v", gotBatch.Items)
	}
}

func TestNightlyBatchContinuePromotesAfterFailedIssue(t *testing.T) {
	st := openTestStore(t)
	ctx := context.Background()
	_, _ = st.CreateProject(ctx, Project{ID: "demo", Name: "Demo", CWD: t.TempDir()})
	first, _ := st.CreateIssue(ctx, Issue{ProjectID: "demo", Title: "first", Status: StatusTriage})
	second, _ := st.CreateIssue(ctx, Issue{ProjectID: "demo", Title: "second", Status: StatusTriage})
	batch, err := st.CreateNightlyBatch(ctx, NightlyBatchInput{
		ProjectID: "demo", IssueIDs: []int64{first.ID, second.ID}, Policy: NightlyPolicyContinue,
	})
	if err != nil {
		t.Fatalf("create batch: %v", err)
	}
	if _, err := st.PromoteNextNightlyBatchIssue(ctx, batch.ID); err != nil {
		t.Fatalf("promote first: %v", err)
	}
	if _, err := st.SetIssueStatus(ctx, first.ID, StatusFailed, "boom"); err != nil {
		t.Fatalf("fail first: %v", err)
	}
	result, err := st.AdvanceNightlyBatchesForIssue(ctx, first.ID)
	if err != nil {
		t.Fatalf("advance after failed: %v", err)
	}
	if len(result) != 1 || result[0].PromotedIssue == nil || result[0].PromotedIssue.ID != second.ID {
		t.Fatalf("continue result = %+v, want second promoted", result)
	}
	gotBatch, _ := st.GetNightlyBatch(ctx, batch.ID)
	if gotBatch.Status != NightlyBatchActive || gotBatch.Items[1].Status != NightlyItemCurrent {
		t.Fatalf("batch should continue with second current: %+v", gotBatch)
	}
}

func TestNightlyBatchProjectHoldPausesPromotion(t *testing.T) {
	st := openTestStore(t)
	ctx := context.Background()
	_, _ = st.CreateProject(ctx, Project{ID: "demo", Name: "Demo", CWD: t.TempDir()})
	issue, _ := st.CreateIssue(ctx, Issue{ProjectID: "demo", Title: "blocked", Status: StatusTriage})
	batch, err := st.CreateNightlyBatch(ctx, NightlyBatchInput{
		ProjectID: "demo", IssueIDs: []int64{issue.ID}, Policy: NightlyPolicyContinue,
	})
	if err != nil {
		t.Fatalf("create batch: %v", err)
	}
	_, _ = st.SetProjectHold(ctx, "demo", ProjectHold{Reason: "dirty_worktree", Message: "dirty"})

	if _, err := st.PromoteNextNightlyBatchIssue(ctx, batch.ID); err != nil {
		t.Fatalf("promote with hold: %v", err)
	}
	gotBatch, _ := st.GetNightlyBatch(ctx, batch.ID)
	gotIssue, _ := st.GetIssue(ctx, issue.ID)
	if gotBatch.Status != NightlyBatchPaused || gotIssue.Status != StatusTriage {
		t.Fatalf("hold should pause without promotion: batch=%+v issue=%+v", gotBatch, gotIssue)
	}
}

func TestNightlyBatchPausesCurrentIssueOnRunnerHold(t *testing.T) {
	st := openTestStore(t)
	ctx := context.Background()
	_, _ = st.CreateProject(ctx, Project{ID: "demo", Name: "Demo", CWD: t.TempDir()})
	first, _ := st.CreateIssue(ctx, Issue{ProjectID: "demo", Title: "first", Status: StatusTriage})
	second, _ := st.CreateIssue(ctx, Issue{ProjectID: "demo", Title: "second", Status: StatusTriage})
	batch, err := st.CreateNightlyBatch(ctx, NightlyBatchInput{
		ProjectID: "demo", IssueIDs: []int64{first.ID, second.ID}, Policy: NightlyPolicyFailStop,
	})
	if err != nil {
		t.Fatalf("create batch: %v", err)
	}
	if _, err := st.PromoteNextNightlyBatchIssue(ctx, batch.ID); err != nil {
		t.Fatalf("promote first: %v", err)
	}

	results, err := st.PauseNightlyBatchesForIssue(ctx, first.ID, "dirty worktree")
	if err != nil {
		t.Fatalf("pause batch: %v", err)
	}
	if len(results) != 1 || results[0].Batch.Status != NightlyBatchPaused {
		t.Fatalf("pause results = %+v", results)
	}
	gotBatch, _ := st.GetNightlyBatch(ctx, batch.ID)
	gotSecond, _ := st.GetIssue(ctx, second.ID)
	if gotBatch.Status != NightlyBatchPaused || gotBatch.PauseReason != "dirty worktree" {
		t.Fatalf("batch not paused: %+v", gotBatch)
	}
	if gotSecond.Status != StatusTriage {
		t.Fatalf("second issue should remain triage: %+v", gotSecond)
	}
}
