package api

import (
	"net/http"

	"github.com/xiaobei/codex-issue-runner/backend/internal/store"
)

func (s *Server) sessionCommandHistory(r *http.Request, threadID string) []store.SessionCommandEventRecord {
	events, err := s.store.ListSessionCommandEvents(r.Context(), threadID)
	if err != nil || len(events) == 0 {
		return nil
	}
	return events
}
