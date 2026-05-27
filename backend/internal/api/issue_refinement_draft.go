package api

import (
	"net/http"

	"github.com/xiaobei/codex-issue-runner/backend/internal/runner"
	"github.com/xiaobei/codex-issue-runner/backend/internal/store"
)

func (s *Server) createIssueRefinementDraft(w http.ResponseWriter, r *http.Request, id int64) {
	if s.runner == nil {
		writeError(w, http.StatusServiceUnavailable, "runner unavailable")
		return
	}
	issue, err := s.store.GetIssue(r.Context(), id)
	if err != nil {
		handleErr(w, err)
		return
	}
	if issue.Status != store.StatusTriage {
		writeError(w, http.StatusBadRequest, "只有 Triage 状态的 Issue 可以生成 refinement 草稿")
		return
	}
	project, err := s.store.GetProject(r.Context(), issue.ProjectID)
	if err != nil {
		handleErr(w, err)
		return
	}
	if project.Provider != store.ProviderCodex {
		writeError(w, http.StatusBadRequest, "project "+project.ID+" provider \""+project.Provider+"\" 暂不支持，当前只支持 codex")
		return
	}
	events, err := s.store.ListIssueEvents(r.Context(), id)
	if err != nil {
		handleErr(w, err)
		return
	}
	profiles, err := s.store.ListAgentProfiles(r.Context())
	if err != nil {
		handleErr(w, err)
		return
	}
	result, err := s.runner.GenerateIssueRefinementDraft(r.Context(), runner.IssueRefinementDraftInput{
		Issue: issue, Project: project, AgentProfiles: profiles, Events: events,
	})
	if err != nil {
		handleErr(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, result)
}
