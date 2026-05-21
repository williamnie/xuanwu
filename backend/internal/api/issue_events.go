package api

import (
	"encoding/json"
	"net/http"

	"github.com/xiaobei/codex-issue-runner/backend/internal/events"
)

func (s *Server) recordIssueEvent(r *http.Request, issueID int64, typ string, payload any) {
	payloadText := ""
	if payload != nil {
		b, _ := json.Marshal(payload)
		payloadText = string(b)
	}
	e, err := s.store.AddIssueEvent(r.Context(), issueID, typ, payloadText)
	if err != nil {
		return
	}
	s.bus.Publish(toAppEvent(e.ID, issueID, typ, payload, e.CreatedAt))
}

func (s *Server) kickAutoProject(r *http.Request, projectID string) {
	project, err := s.store.GetProject(r.Context(), projectID)
	if err == nil && project.AutoRun == 1 {
		_ = s.runner.StartProject(projectID)
	}
}

func toAppEvent(id, issueID int64, typ string, payload any, createdAt string) events.AppEvent {
	e := events.AppEvent{ID: id, Type: typ, IssueID: issueID, CreatedAt: createdAt}
	if m, ok := payload.(map[string]string); ok {
		e.Status = m["status"]
		e.Error = m["error"]
	}
	return e
}

func ptr(value string) *string {
	return &value
}
