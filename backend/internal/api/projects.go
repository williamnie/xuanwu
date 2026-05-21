package api

import (
	"net/http"

	"github.com/xiaobei/codex-issue-runner/backend/internal/store"
)

func (s *Server) routeProjects(w http.ResponseWriter, r *http.Request, parts []string) {
	if len(parts) == 1 {
		s.handleProjects(w, r)
		return
	}
	if len(parts) == 2 {
		s.handleProject(w, r, parts[1])
		return
	}
	if len(parts) == 3 && parts[1] == "sync" && parts[2] == "codex" {
		s.syncCodexProjects(w, r)
		return
	}
	if len(parts) == 4 && parts[2] == "loop" {
		s.handleProjectLoop(w, r, parts[1], parts[3])
		return
	}
	writeError(w, http.StatusNotFound, "not found")
}

func (s *Server) handleProjects(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		projects, err := s.store.ListProjects(r.Context())
		if err != nil {
			handleErr(w, err)
			return
		}
		s.attachLoopStatus(projects)
		writeJSON(w, http.StatusOK, projects)
	case http.MethodPost:
		s.createProject(w, r)
	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

func (s *Server) handleProject(w http.ResponseWriter, r *http.Request, id string) {
	switch r.Method {
	case http.MethodGet:
		s.writeProject(w, r, id)
	case http.MethodPatch:
		s.patchProject(w, r, id)
	case http.MethodDelete:
		if err := s.store.DeleteProject(r.Context(), id); err != nil {
			handleErr(w, err)
			return
		}
		s.runner.StopProject(id)
		w.WriteHeader(http.StatusNoContent)
	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

func (s *Server) createProject(w http.ResponseWriter, r *http.Request) {
	var p store.Project
	if err := decodeJSON(r, &p); err != nil {
		writeError(w, http.StatusBadRequest, "请求体不是合法 JSON")
		return
	}
	created, err := s.store.CreateProject(r.Context(), p)
	if err != nil {
		handleErr(w, err)
		return
	}
	if created.AutoRun == 1 {
		_ = s.runner.StartProject(created.ID)
	}
	created.LoopStatus = s.runner.LoopStatus(created.ID)
	writeJSON(w, http.StatusCreated, created)
}

func (s *Server) patchProject(w http.ResponseWriter, r *http.Request, id string) {
	var patch store.ProjectPatch
	if err := decodeJSON(r, &patch); err != nil {
		writeError(w, http.StatusBadRequest, "请求体不是合法 JSON")
		return
	}
	updated, err := s.store.UpdateProject(r.Context(), id, patch)
	if err != nil {
		handleErr(w, err)
		return
	}
	s.applyAutoRun(id, updated.AutoRun)
	updated.LoopStatus = s.runner.LoopStatus(id)
	writeJSON(w, http.StatusOK, updated)
}

func (s *Server) handleProjectLoop(w http.ResponseWriter, r *http.Request, id, action string) {
	if action == "status" && requireMethod(w, r, http.MethodGet) {
		writeJSON(w, http.StatusOK, map[string]string{"status": s.runner.LoopStatus(id)})
		return
	}
	if !requireMethod(w, r, http.MethodPost) {
		return
	}
	one, zero := 1, 0
	if action == "start" {
		if _, err := s.store.UpdateProject(r.Context(), id, store.ProjectPatch{AutoRun: &one}); err != nil {
			handleErr(w, err)
			return
		}
		if err := s.runner.StartProject(id); err != nil {
			handleErr(w, err)
			return
		}
	} else if action == "stop" {
		if _, err := s.store.UpdateProject(r.Context(), id, store.ProjectPatch{AutoRun: &zero}); err != nil {
			handleErr(w, err)
			return
		}
		s.runner.StopProject(id)
	} else {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": s.runner.LoopStatus(id)})
}

func (s *Server) writeProject(w http.ResponseWriter, r *http.Request, id string) {
	p, err := s.store.GetProject(r.Context(), id)
	if err != nil {
		handleErr(w, err)
		return
	}
	p.LoopStatus = s.runner.LoopStatus(id)
	writeJSON(w, http.StatusOK, p)
}

func (s *Server) attachLoopStatus(projects []store.Project) {
	for i := range projects {
		projects[i].LoopStatus = s.runner.LoopStatus(projects[i].ID)
	}
}

func (s *Server) applyAutoRun(id string, autoRun int) {
	if autoRun == 1 {
		_ = s.runner.StartProject(id)
		return
	}
	s.runner.StopProject(id)
}
