package api

import (
	"net/http"

	"github.com/xiaobei/codex-issue-runner/backend/internal/agent"
)

type resolveApprovalRequest struct {
	Decision string `json:"decision"`
	Scope    string `json:"scope"`
}

func (s *Server) routeCodex(w http.ResponseWriter, r *http.Request, parts []string) {
	if len(parts) == 2 && parts[1] == "models" {
		s.listCodexModels(w, r)
		return
	}
	if len(parts) == 4 && parts[1] == "approvals" && parts[3] == "resolve" {
		s.resolveCodexApproval(w, r, parts[2])
		return
	}
	writeError(w, http.StatusNotFound, "not found")
}

func (s *Server) listCodexModels(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodGet) {
		return
	}
	result, err := s.runner.ListModels(r.Context())
	if err != nil {
		handleErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) resolveCodexApproval(w http.ResponseWriter, r *http.Request, requestID string) {
	if !requireMethod(w, r, http.MethodPost) {
		return
	}
	var req resolveApprovalRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "请求体不是合法 JSON")
		return
	}
	decision := agent.ApprovalDecision{Decision: req.Decision, Scope: req.Scope}
	if err := s.runner.ResolveApproval(r.Context(), requestID, decision); err != nil {
		handleErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}
