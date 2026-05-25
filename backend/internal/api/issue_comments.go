package api

import (
	"net/http"
	"strings"
)

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
