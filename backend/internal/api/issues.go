package api

import (
	"net/http"

	"github.com/xiaobei/codex-issue-runner/backend/internal/runner"
	"github.com/xiaobei/codex-issue-runner/backend/internal/store"
)

func (s *Server) routeIssues(w http.ResponseWriter, r *http.Request, parts []string) {
	if len(parts) == 1 {
		s.handleIssues(w, r)
		return
	}
	id, err := parseIssueID(parts[1])
	if err != nil {
		writeError(w, http.StatusBadRequest, "issue id 不合法")
		return
	}
	if len(parts) == 2 {
		s.handleIssue(w, r, id)
		return
	}
	if len(parts) == 3 {
		s.handleIssueAction(w, r, id, parts[2])
		return
	}
	writeError(w, http.StatusNotFound, "not found")
}

func (s *Server) handleIssues(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		filter := store.IssueFilter{
			ProjectID:       r.URL.Query().Get("projectId"),
			Status:          r.URL.Query().Get("status"),
			SourceSessionID: sourceSessionQuery(r),
		}
		issues, err := s.store.ListIssues(r.Context(), filter)
		if err != nil {
			handleErr(w, err)
			return
		}
		writeJSON(w, http.StatusOK, issues)
	case http.MethodPost:
		s.createIssue(w, r)
	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

func sourceSessionQuery(r *http.Request) string {
	if value := r.URL.Query().Get("sourceSessionId"); value != "" {
		return value
	}
	return r.URL.Query().Get("source_session_id")
}

func (s *Server) handleIssue(w http.ResponseWriter, r *http.Request, id int64) {
	switch r.Method {
	case http.MethodGet:
		s.writeIssue(w, r, id)
	case http.MethodPatch:
		s.patchIssue(w, r, id)
	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

func (s *Server) createIssue(w http.ResponseWriter, r *http.Request) {
	var issue store.Issue
	if err := decodeJSON(r, &issue); err != nil {
		writeError(w, http.StatusBadRequest, "请求体不是合法 JSON")
		return
	}
	if issue.Status == store.StatusTodo && !s.ensureIssueProjectRunnable(w, r, issue.ProjectID) {
		return
	}
	created, err := s.store.CreateIssue(r.Context(), issue)
	if err != nil {
		handleErr(w, err)
		return
	}
	s.recordIssueEvent(r, created.ID, "issue.created", nil)
	s.kickAutoProject(r, created.ProjectID)
	writeJSON(w, http.StatusCreated, created)
}

func (s *Server) patchIssue(w http.ResponseWriter, r *http.Request, id int64) {
	before, _ := s.store.GetIssue(r.Context(), id)
	var patch store.IssuePatch
	if err := decodeJSON(r, &patch); err != nil {
		writeError(w, http.StatusBadRequest, "请求体不是合法 JSON")
		return
	}
	if patch.Status != nil && *patch.Status == store.StatusTodo {
		current := before
		if current.ID == 0 {
			var err error
			current, err = s.store.GetIssue(r.Context(), id)
			if err != nil {
				handleErr(w, err)
				return
			}
		}
		if !s.ensureIssueProjectRunnable(w, r, current.ProjectID) {
			return
		}
	}
	updated, err := s.updateIssueWithLifecycle(r, id, before, patch)
	if err != nil {
		handleErr(w, err)
		return
	}
	if patch.Status != nil {
		s.recordIssueEvent(r, id, "issue.status_changed", map[string]string{"status": updated.Status})
		s.notifyTerminalIssue(r, before.Status, updated)
	}
	writeJSON(w, http.StatusOK, updated)
}

func (s *Server) updateIssueWithLifecycle(
	r *http.Request,
	id int64,
	before store.Issue,
	patch store.IssuePatch,
) (store.Issue, error) {
	if patch.Status == nil || before.Status != store.StatusInProgress ||
		*patch.Status == store.StatusInProgress || *patch.Status == store.StatusDone ||
		*patch.Status == store.StatusFailed || *patch.Status == store.StatusCancelled ||
		before.CodexThreadID == "" || before.CodexTurnID == "" {
		return s.store.UpdateIssue(r.Context(), id, patch)
	}
	return s.interruptIssueForStatusChange(r, before, patch)
}

func (s *Server) interruptIssueForStatusChange(
	r *http.Request,
	before store.Issue,
	patch store.IssuePatch,
) (store.Issue, error) {
	status := *patch.Status
	errText := ""
	if patch.Error != nil {
		errText = *patch.Error
	}
	result, err := s.runner.InterruptIssue(r.Context(), runner.IssueInterruptRequest{
		IssueID: before.ID, Status: status, RunStatus: store.StatusCancelled,
		ExitReason: "interrupted_by_status_change", EventType: "issue.interrupt_requested",
		ErrorMessage: errText,
	})
	if err != nil {
		return store.Issue{}, err
	}
	return s.applyNonLifecycleIssuePatch(r, result.Issue, patch)
}

func (s *Server) applyNonLifecycleIssuePatch(
	r *http.Request,
	issue store.Issue,
	patch store.IssuePatch,
) (store.Issue, error) {
	patch.Status = nil
	patch.Error = nil
	if patch.Title == nil && patch.Description == nil && patch.Priority == nil &&
		patch.CodexThreadID == nil && patch.CodexTurnID == nil &&
		patch.AutoRetryNextAt == nil && patch.AutoRetryReason == nil {
		return issue, nil
	}
	return s.store.UpdateIssue(r.Context(), issue.ID, patch)
}

func (s *Server) handleIssueAction(w http.ResponseWriter, r *http.Request, id int64, action string) {
	if action == "events" && requireMethod(w, r, http.MethodGet) {
		events, err := s.store.ListIssueEvents(r.Context(), id)
		if err != nil {
			handleErr(w, err)
			return
		}
		writeJSON(w, http.StatusOK, events)
		return
	}
	if action == "runs" && requireMethod(w, r, http.MethodGet) {
		runs, err := s.store.ListIssueRuns(r.Context(), id)
		if err != nil {
			handleErr(w, err)
			return
		}
		writeJSON(w, http.StatusOK, runs)
		return
	}
	if action == "comments" && requireMethod(w, r, http.MethodPost) {
		s.createIssueComment(w, r, id)
		return
	}
	if action == "refinement-draft" && requireMethod(w, r, http.MethodPost) {
		s.createIssueRefinementDraft(w, r, id)
		return
	}
	if !requireMethod(w, r, http.MethodPost) {
		return
	}
	s.runIssueAction(w, r, id, action)
}

func (s *Server) runIssueAction(w http.ResponseWriter, r *http.Request, id int64, action string) {
	switch action {
	case "enqueue", "retry":
		s.setIssueQueued(w, r, id)
	case "cancel":
		s.cancelIssue(w, r, id)
	default:
		writeError(w, http.StatusNotFound, "not found")
	}
}

func (s *Server) setIssueQueued(w http.ResponseWriter, r *http.Request, id int64) {
	current, err := s.store.GetIssue(r.Context(), id)
	if err != nil {
		handleErr(w, err)
		return
	}
	if !s.ensureIssueProjectRunnable(w, r, current.ProjectID) {
		return
	}
	issue, err := s.store.UpdateIssue(r.Context(), id, store.IssuePatch{
		Status: ptr(store.StatusTodo), Error: ptr(""), CodexThreadID: ptr(""), CodexTurnID: ptr(""),
	})
	if err != nil {
		handleErr(w, err)
		return
	}
	s.recordIssueEvent(r, id, "issue.status_changed", map[string]string{"status": store.StatusTodo})
	s.kickAutoProject(r, issue.ProjectID)
	writeJSON(w, http.StatusOK, issue)
}

func (s *Server) ensureIssueProjectRunnable(w http.ResponseWriter, r *http.Request, projectID string) bool {
	project, err := s.store.GetProject(r.Context(), projectID)
	if err != nil {
		handleErr(w, err)
		return false
	}
	if project.Provider != store.ProviderCodex {
		writeError(w, http.StatusBadRequest, "project "+project.ID+" provider \""+project.Provider+"\" 暂不支持，当前只支持 codex")
		return false
	}
	return true
}

func (s *Server) cancelIssue(w http.ResponseWriter, r *http.Request, id int64) {
	s.runner.CancelIssue(id)
	issue, err := s.store.SetIssueStatus(r.Context(), id, store.StatusCancelled, "")
	if err != nil {
		handleErr(w, err)
		return
	}
	s.recordIssueEvent(r, id, "issue.status_changed", map[string]string{"status": store.StatusCancelled})
	writeJSON(w, http.StatusOK, issue)
}

func (s *Server) writeIssue(w http.ResponseWriter, r *http.Request, id int64) {
	issue, err := s.store.GetIssue(r.Context(), id)
	if err != nil {
		handleErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, issue)
}

func (s *Server) notifyTerminalIssue(r *http.Request, previousStatus string, issue store.Issue) {
	if s.notifier == nil || previousStatus == issue.Status {
		return
	}
	if issue.Status != store.StatusDone && issue.Status != store.StatusFailed {
		return
	}
	s.notifier.NotifyIssueStatus(r.Context(), issue)
}
