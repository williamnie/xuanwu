package api

import (
	"net/http"

	"github.com/xiaobei/codex-issue-runner/backend/internal/store"
)

func (s *Server) routeIssueTemplates(w http.ResponseWriter, r *http.Request, parts []string) {
	if len(parts) == 1 {
		s.handleIssueTemplates(w, r)
		return
	}
	if len(parts) == 2 {
		s.handleIssueTemplate(w, r, parts[1])
		return
	}
	writeError(w, http.StatusNotFound, "not found")
}

func (s *Server) handleIssueTemplates(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		s.listIssueTemplates(w, r)
	case http.MethodPost:
		s.createIssueTemplate(w, r)
	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

func (s *Server) handleIssueTemplate(w http.ResponseWriter, r *http.Request, id string) {
	switch r.Method {
	case http.MethodGet:
		s.writeIssueTemplate(w, r, id)
	case http.MethodPatch:
		s.patchIssueTemplate(w, r, id)
	case http.MethodDelete:
		if err := s.store.DeleteIssueTemplate(r.Context(), id); err != nil {
			handleErr(w, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

func (s *Server) listIssueTemplates(w http.ResponseWriter, r *http.Request) {
	templates, err := s.store.ListIssueTemplates(r.Context())
	if err != nil {
		handleErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, templates)
}

func (s *Server) createIssueTemplate(w http.ResponseWriter, r *http.Request) {
	var tmpl store.IssueTemplate
	if err := decodeJSON(r, &tmpl); err != nil {
		writeError(w, http.StatusBadRequest, "请求体不是合法 JSON")
		return
	}
	created, err := s.store.CreateIssueTemplate(r.Context(), tmpl)
	if err != nil {
		handleErr(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, created)
}

func (s *Server) writeIssueTemplate(w http.ResponseWriter, r *http.Request, id string) {
	tmpl, err := s.store.GetIssueTemplate(r.Context(), id)
	if err != nil {
		handleErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, tmpl)
}

func (s *Server) patchIssueTemplate(w http.ResponseWriter, r *http.Request, id string) {
	var patch store.IssueTemplatePatch
	if err := decodeJSON(r, &patch); err != nil {
		writeError(w, http.StatusBadRequest, "请求体不是合法 JSON")
		return
	}
	updated, err := s.store.UpdateIssueTemplate(r.Context(), id, patch)
	if err != nil {
		handleErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, updated)
}
