package api

import (
	"net/http"
	"strconv"

	"github.com/xiaobei/codex-issue-runner/backend/internal/runner"
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
	if len(parts) == 4 && parts[2] == "hold" {
		s.handleProjectHold(w, r, parts[1], parts[3])
		return
	}
	if len(parts) == 4 && parts[2] == "loop" {
		s.handleProjectLoop(w, r, parts[1], parts[3])
		return
	}
	if len(parts) == 4 && parts[2] == "references" && parts[3] == "search" {
		s.searchProjectReferences(w, r, parts[1])
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
		store.AttachProjectCapabilities(projects)
		writeJSON(w, http.StatusOK, projects)
	case http.MethodPost:
		s.createProject(w, r)
	case http.MethodPatch:
		s.reorderProjects(w, r)
	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

func (s *Server) reorderProjects(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ProjectIDs []string `json:"project_ids"`
	}
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "请求体不是合法 JSON")
		return
	}
	projects, err := s.store.ReorderProjects(r.Context(), req.ProjectIDs)
	if err != nil {
		handleErr(w, err)
		return
	}
	s.attachLoopStatus(projects)
	store.AttachProjectCapabilities(projects)
	writeJSON(w, http.StatusOK, projects)
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
	if p.AutoRun == 1 && !s.projectCanAutoRun(w, p) {
		return
	}
	created, err := s.store.CreateProject(r.Context(), p)
	if err != nil {
		handleErr(w, err)
		return
	}
	if created.AutoRun == 1 {
		if err := s.runner.StartProject(created.ID); err != nil {
			handleErr(w, err)
			return
		}
	}
	created.LoopStatus = s.runner.LoopStatus(created.ID)
	store.AttachProjectCapability(&created)
	writeJSON(w, http.StatusCreated, created)
}

func (s *Server) patchProject(w http.ResponseWriter, r *http.Request, id string) {
	var patch store.ProjectPatch
	if err := decodeJSON(r, &patch); err != nil {
		writeError(w, http.StatusBadRequest, "请求体不是合法 JSON")
		return
	}
	if !s.projectPatchCanAutoRun(w, r, id, patch) {
		return
	}
	updated, err := s.store.UpdateProject(r.Context(), id, patch)
	if err != nil {
		handleErr(w, err)
		return
	}
	if err := s.applyAutoRun(id, updated.AutoRun); err != nil {
		handleErr(w, err)
		return
	}
	updated.LoopStatus = s.runner.LoopStatus(id)
	store.AttachProjectCapability(&updated)
	writeJSON(w, http.StatusOK, updated)
}

func (s *Server) projectPatchCanAutoRun(
	w http.ResponseWriter,
	r *http.Request,
	id string,
	patch store.ProjectPatch,
) bool {
	if patch.AutoRun == nil && patch.Provider == nil {
		return true
	}
	current, err := s.store.GetProject(r.Context(), id)
	if err != nil {
		handleErr(w, err)
		return false
	}
	provider := current.Provider
	if patch.Provider != nil {
		provider = *patch.Provider
	}
	autoRun := current.AutoRun
	if patch.AutoRun != nil {
		autoRun = *patch.AutoRun
	}
	if autoRun != 1 {
		return true
	}
	current.Provider = provider
	return s.projectCanAutoRun(w, current)
}

func (s *Server) projectCanAutoRun(w http.ResponseWriter, project store.Project) bool {
	if err := s.runner.ValidateIssueExecutionProvider(project); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return false
	}
	return true
}

func (s *Server) searchProjectReferences(w http.ResponseWriter, r *http.Request, id string) {
	if !requireMethod(w, r, http.MethodGet) {
		return
	}
	project, err := s.store.GetProject(r.Context(), id)
	if err != nil {
		handleErr(w, err)
		return
	}
	result, err := runner.SearchProjectReferences(project.CWD, runner.ProjectReferenceSearchFilter{
		Type: r.URL.Query().Get("type"), Query: r.URL.Query().Get("query"),
		Limit: parseReferenceSearchLimit(r),
	})
	if err != nil {
		handleErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func parseReferenceSearchLimit(r *http.Request) int {
	limit, err := strconv.Atoi(r.URL.Query().Get("limit"))
	if err != nil || limit <= 0 {
		return 40
	}
	if limit > 200 {
		return 200
	}
	return limit
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

func (s *Server) handleProjectHold(w http.ResponseWriter, r *http.Request, id, action string) {
	if action == "status" && requireMethod(w, r, http.MethodGet) {
		project, err := s.store.GetProject(r.Context(), id)
		if err != nil {
			handleErr(w, err)
			return
		}
		if project.Hold == nil {
			writeJSON(w, http.StatusOK, store.ProjectHold{})
			return
		}
		writeJSON(w, http.StatusOK, project.Hold)
		return
	}
	if action == "clear" && requireMethod(w, r, http.MethodPost) {
		project, err := s.store.ClearProjectHold(r.Context(), id)
		if err != nil {
			handleErr(w, err)
			return
		}
		if project.AutoRun == 1 {
			_ = s.runner.StartProject(id)
		}
		project.LoopStatus = s.runner.LoopStatus(id)
		writeJSON(w, http.StatusOK, project)
		return
	}
	if action == "resume" && requireMethod(w, r, http.MethodPost) {
		project, err := s.runner.ResumeHeldProject(r.Context(), id)
		if err != nil && project.ID == "" {
			handleErr(w, err)
			return
		}
		project.LoopStatus = s.runner.LoopStatus(id)
		store.AttachProjectCapability(&project)
		if err != nil {
			writeJSON(w, http.StatusConflict, map[string]any{
				"message": err.Error(),
				"project": project,
			})
			return
		}
		writeJSON(w, http.StatusOK, project)
		return
	}
	writeError(w, http.StatusNotFound, "not found")
}

func (s *Server) writeProject(w http.ResponseWriter, r *http.Request, id string) {
	p, err := s.store.GetProject(r.Context(), id)
	if err != nil {
		handleErr(w, err)
		return
	}
	p.LoopStatus = s.runner.LoopStatus(id)
	store.AttachProjectCapability(&p)
	writeJSON(w, http.StatusOK, p)
}

func (s *Server) attachLoopStatus(projects []store.Project) {
	for i := range projects {
		projects[i].LoopStatus = s.runner.LoopStatus(projects[i].ID)
	}
}

func (s *Server) applyAutoRun(id string, autoRun int) error {
	if autoRun == 1 {
		return s.runner.StartProject(id)
	}
	s.runner.StopProject(id)
	return nil
}
