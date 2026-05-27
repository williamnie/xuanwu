package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/xiaobei/codex-issue-runner/backend/internal/store"
)

func TestNightlyBatchAPICreatePromotesFirstIssue(t *testing.T) {
	srv := newTestServer(t)
	postJSON[store.Project](t, srv, "/api/projects", map[string]any{
		"id": "demo", "cwd": t.TempDir(), "auto_run": 1,
	})
	first := postJSON[store.Issue](t, srv, "/api/issues", map[string]any{
		"project_id": "demo", "title": "first", "status": store.StatusTriage,
	})
	second := postJSON[store.Issue](t, srv, "/api/issues", map[string]any{
		"project_id": "demo", "title": "second", "status": store.StatusTriage,
	})

	batch := postJSON[store.NightlyBatch](t, srv, "/api/nightly-batches", map[string]any{
		"project_id": "demo", "issue_ids": []int64{first.ID, second.ID}, "policy": store.NightlyPolicyFailStop,
	})

	if batch.Status != store.NightlyBatchActive || batch.CurrentIssueID != first.ID || len(batch.Items) != 2 {
		t.Fatalf("batch not created/promoted: %+v", batch)
	}
	gotFirst := getJSON[store.Issue](t, srv, "/api/issues/1")
	gotSecond := getJSON[store.Issue](t, srv, "/api/issues/2")
	if gotFirst.Status != store.StatusTodo || gotSecond.Status != store.StatusTriage {
		t.Fatalf("expected only first promoted: first=%+v second=%+v", gotFirst, gotSecond)
	}
	assertAPIEvent(t, srv, first.ID, "issue.status_changed")
}

func TestNightlyBatchAPIRejectsNonTriageIssue(t *testing.T) {
	srv := newTestServer(t)
	postJSON[store.Project](t, srv, "/api/projects", map[string]any{"id": "demo", "cwd": t.TempDir()})
	issue := postJSON[store.Issue](t, srv, "/api/issues", map[string]any{
		"project_id": "demo", "title": "todo", "status": store.StatusTriage,
	})
	patchJSON[store.Issue](t, srv, "/api/issues/1", map[string]any{"status": store.StatusTodo})

	req := httptest.NewRequest(http.MethodPost, "/api/nightly-batches", strings.NewReader(`{"project_id":"demo","issue_ids":[1]}`))
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()
	srv.ServeHTTP(rr, req)
	if rr.Code != http.StatusBadRequest || !strings.Contains(rr.Body.String(), "不是 triage") {
		t.Fatalf("status=%d body=%s", rr.Code, rr.Body.String())
	}
	got, _ := srv.store.GetIssue(context.Background(), issue.ID)
	if got.Status != store.StatusTodo {
		t.Fatalf("issue should remain todo: %+v", got)
	}
}

func TestNightlyBatchAPIFailStopPausesAfterFailedPatch(t *testing.T) {
	srv := newTestServer(t)
	postJSON[store.Project](t, srv, "/api/projects", map[string]any{
		"id": "demo", "cwd": t.TempDir(),
	})
	first := postJSON[store.Issue](t, srv, "/api/issues", map[string]any{
		"project_id": "demo", "title": "first", "status": store.StatusTriage,
	})
	second := postJSON[store.Issue](t, srv, "/api/issues", map[string]any{
		"project_id": "demo", "title": "second", "status": store.StatusTriage,
	})
	batch := postJSON[store.NightlyBatch](t, srv, "/api/nightly-batches", map[string]any{
		"project_id": "demo", "issue_ids": []int64{first.ID, second.ID}, "policy": store.NightlyPolicyFailStop,
	})

	patchJSON[store.Issue](t, srv, "/api/issues/1", map[string]any{
		"status": store.StatusFailed, "error": "boom",
	})

	gotBatch := getJSON[store.NightlyBatch](t, srv, "/api/nightly-batches/1")
	gotSecond := getJSON[store.Issue](t, srv, "/api/issues/2")
	if batch.ID != gotBatch.ID || gotBatch.Status != store.NightlyBatchPaused {
		t.Fatalf("batch should pause: before=%+v after=%+v", batch, gotBatch)
	}
	if gotSecond.Status != store.StatusTriage {
		t.Fatalf("second issue should remain triage: %+v", gotSecond)
	}
}
