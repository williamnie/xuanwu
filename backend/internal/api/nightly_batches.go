package api

import (
	"encoding/json"
	"net/http"

	"github.com/xiaobei/codex-issue-runner/backend/internal/events"
	"github.com/xiaobei/codex-issue-runner/backend/internal/store"
)

func (s *Server) routeNightlyBatches(w http.ResponseWriter, r *http.Request, parts []string) {
	if len(parts) == 1 {
		s.handleNightlyBatches(w, r)
		return
	}
	id, err := parseIssueID(parts[1])
	if err != nil {
		writeError(w, http.StatusBadRequest, "nightly batch id 不合法")
		return
	}
	if len(parts) == 2 && r.Method == http.MethodGet {
		s.writeNightlyBatch(w, r, id)
		return
	}
	if len(parts) == 3 && parts[2] == "promote" && requireMethod(w, r, http.MethodPost) {
		s.promoteNightlyBatch(w, r, id)
		return
	}
	writeError(w, http.StatusNotFound, "not found")
}

func (s *Server) handleNightlyBatches(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		batches, err := s.store.ListNightlyBatches(r.Context(), r.URL.Query().Get("projectId"))
		if err != nil {
			handleErr(w, err)
			return
		}
		writeJSON(w, http.StatusOK, batches)
	case http.MethodPost:
		s.createNightlyBatch(w, r)
	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

func (s *Server) createNightlyBatch(w http.ResponseWriter, r *http.Request) {
	var input store.NightlyBatchInput
	if err := decodeJSON(r, &input); err != nil {
		writeError(w, http.StatusBadRequest, "请求体不是合法 JSON")
		return
	}
	batch, err := s.store.CreateNightlyBatch(r.Context(), input)
	if err != nil {
		handleErr(w, err)
		return
	}
	result, err := s.store.PromoteNextNightlyBatchIssue(r.Context(), batch.ID)
	if err != nil {
		handleErr(w, err)
		return
	}
	s.recordNightlyBatchResult(r, result)
	writeJSON(w, http.StatusCreated, result.Batch)
}

func (s *Server) promoteNightlyBatch(w http.ResponseWriter, r *http.Request, id int64) {
	result, err := s.store.PromoteNextNightlyBatchIssue(r.Context(), id)
	if err != nil {
		handleErr(w, err)
		return
	}
	s.recordNightlyBatchResult(r, result)
	writeJSON(w, http.StatusOK, result.Batch)
}

func (s *Server) writeNightlyBatch(w http.ResponseWriter, r *http.Request, id int64) {
	batch, err := s.store.GetNightlyBatch(r.Context(), id)
	if err != nil {
		handleErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, batch)
}

func (s *Server) recordNightlyBatchResult(r *http.Request, result store.NightlyBatchAdvanceResult) {
	payload, _ := json.Marshal(map[string]any{
		"batch_id":         result.Batch.ID,
		"status":           result.Batch.Status,
		"current_issue_id": result.Batch.CurrentIssueID,
		"pause_reason":     result.Batch.PauseReason,
	})
	s.bus.Publish(events.AppEvent{
		Type: "nightly_batch.updated", ProjectID: result.Batch.ProjectID,
		Status: result.Batch.Status, Error: result.Batch.PauseReason, Payload: string(payload),
	})
	s.recordNightlyPromotion(r, result.PromotedIssue)
}

func (s *Server) recordNightlyPromotion(r *http.Request, issue *store.Issue) {
	if issue == nil {
		return
	}
	s.recordIssueEvent(r, issue.ID, "issue.status_changed", map[string]string{
		"status": store.StatusTodo,
		"source": "nightly_batch",
	})
	s.kickAutoProject(r, issue.ProjectID)
}

func (s *Server) advanceNightlyBatchAfterIssuePatch(r *http.Request, issue store.Issue) {
	if issue.Status != store.StatusDone && issue.Status != store.StatusFailed && issue.Status != store.StatusCancelled {
		return
	}
	results, err := s.store.AdvanceNightlyBatchesForIssue(r.Context(), issue.ID)
	if err != nil {
		s.bus.Publish(events.AppEvent{Type: "nightly_batch.error", IssueID: issue.ID, Error: err.Error()})
		return
	}
	for _, result := range results {
		s.recordNightlyBatchResult(r, result)
	}
}
