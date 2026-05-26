package api

import (
	"net/http"

	"github.com/xiaobei/codex-issue-runner/backend/internal/runner"
)

func (s *Server) handleCapabilities(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodGet) {
		return
	}
	writeJSON(w, http.StatusOK, runner.DiscoverInstalledCapabilities())
}
