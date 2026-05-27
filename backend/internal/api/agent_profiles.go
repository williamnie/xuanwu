package api

import (
	"net/http"

	"github.com/xiaobei/codex-issue-runner/backend/internal/store"
)

func (s *Server) routeAgentProfiles(w http.ResponseWriter, r *http.Request, parts []string) {
	if len(parts) == 1 {
		s.handleAgentProfiles(w, r)
		return
	}
	if len(parts) == 2 {
		s.handleAgentProfile(w, r, parts[1])
		return
	}
	writeError(w, http.StatusNotFound, "not found")
}

func (s *Server) handleAgentProfiles(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		profiles, err := s.store.ListAgentProfiles(r.Context())
		if err != nil {
			handleErr(w, err)
			return
		}
		writeJSON(w, http.StatusOK, profiles)
	case http.MethodPost:
		var profile store.AgentProfile
		if err := decodeJSON(r, &profile); err != nil {
			writeError(w, http.StatusBadRequest, "请求体不是合法 JSON")
			return
		}
		created, err := s.store.CreateAgentProfile(r.Context(), profile)
		if err != nil {
			handleErr(w, err)
			return
		}
		writeJSON(w, http.StatusCreated, created)
	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

func (s *Server) handleAgentProfile(w http.ResponseWriter, r *http.Request, id string) {
	switch r.Method {
	case http.MethodGet:
		profile, err := s.store.GetAgentProfile(r.Context(), id)
		if err != nil {
			handleErr(w, err)
			return
		}
		writeJSON(w, http.StatusOK, profile)
	case http.MethodPatch:
		var patch store.AgentProfilePatch
		if err := decodeJSON(r, &patch); err != nil {
			writeError(w, http.StatusBadRequest, "请求体不是合法 JSON")
			return
		}
		updated, err := s.store.UpdateAgentProfile(r.Context(), id, patch)
		if err != nil {
			handleErr(w, err)
			return
		}
		writeJSON(w, http.StatusOK, updated)
	case http.MethodDelete:
		if err := s.store.DeleteAgentProfile(r.Context(), id); err != nil {
			handleErr(w, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}
