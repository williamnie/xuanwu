package api

import (
	"net/http"
	"strings"

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
		filter := store.IssueFilter{ProjectID: r.URL.Query().Get("projectId"), Status: r.URL.Query().Get("status")}
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
	updated, err := s.store.UpdateIssue(r.Context(), id, patch)
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
	if action == "comments" && requireMethod(w, r, http.MethodPost) {
		s.createIssueComment(w, r, id)
		return
	}
	if !requireMethod(w, r, http.MethodPost) {
		return
	}
	s.runIssueAction(w, r, id, action)
}

type issueCommentRequest struct {
	Body   string `json:"body"`
	Author string `json:"author"`
}

func (s *Server) createIssueComment(w http.ResponseWriter, r *http.Request, id int64) {
	if _, err := s.store.GetIssue(r.Context(), id); err != nil {
		handleErr(w, err)
		return
	}
	var req issueCommentRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "请求体不是合法 JSON")
		return
	}
	body := strings.TrimSpace(req.Body)
	if body == "" {
		writeError(w, http.StatusBadRequest, "评论内容不能为空")
		return
	}
	author := strings.TrimSpace(req.Author)
	if author == "" {
		author = "user"
	}
	if !validIssueCommentAuthor(author) {
		writeError(w, http.StatusBadRequest, "评论作者必须是 user、agent 或 system")
		return
	}
	payload := map[string]string{"author": author, "body": body}
	event, err := s.recordIssueEvent(r, id, "issue.comment", payload)
	if err != nil {
		handleErr(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, event)
}

func validIssueCommentAuthor(author string) bool {
	switch author {
	case "user", "agent", "system":
		return true
	default:
		return false
	}
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
