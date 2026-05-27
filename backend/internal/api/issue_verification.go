package api

import (
	"net/http"
	"strings"

	"github.com/xiaobei/codex-issue-runner/backend/internal/store"
)

type issueVerificationRequest struct {
	Action  string `json:"action"`
	Comment string `json:"comment"`
}

type verificationPatch struct {
	Status string
	Error  string
}

func (s *Server) reviewIssueVerification(w http.ResponseWriter, r *http.Request, id int64) {
	current, err := s.store.GetIssue(r.Context(), id)
	if err != nil {
		handleErr(w, err)
		return
	}
	if current.Status != store.StatusPendingVerification {
		writeError(w, http.StatusBadRequest, "issue 当前不在 pending_verification 状态")
		return
	}
	var req issueVerificationRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "请求体不是合法 JSON")
		return
	}
	patch, ok := verificationReviewPatch(req)
	if !ok {
		writeError(w, http.StatusBadRequest, "verification action 必须是 accept、reject 或 request_changes")
		return
	}
	updated, err := s.store.UpdateIssue(r.Context(), id, store.IssuePatch{Status: &patch.Status, Error: &patch.Error})
	if err != nil {
		handleErr(w, err)
		return
	}
	if comment := strings.TrimSpace(req.Comment); comment != "" {
		if _, err := s.recordIssueEvent(r, id, "issue.comment", map[string]string{
			"author": "user", "body": comment,
		}); err != nil {
			handleErr(w, err)
			return
		}
	}
	s.recordIssueEvent(r, id, "issue.verification_reviewed", map[string]string{
		"action": strings.TrimSpace(req.Action), "status": patch.Status, "comment": strings.TrimSpace(req.Comment),
	})
	s.recordIssueEvent(r, id, "issue.status_changed", map[string]string{"status": patch.Status})
	s.notifyTerminalIssue(r, current.Status, updated)
	writeJSON(w, http.StatusOK, updated)
}

func verificationReviewPatch(req issueVerificationRequest) (verificationPatch, bool) {
	comment := strings.TrimSpace(req.Comment)
	switch strings.TrimSpace(req.Action) {
	case "accept":
		return verificationPatch{Status: store.StatusDone}, true
	case "reject":
		return verificationPatch{
			Status: store.StatusFailed,
			Error:  firstNonEmptyComment(comment, "Verification rejected"),
		}, true
	case "request_changes":
		return verificationPatch{
			Status: store.StatusTriage,
			Error:  firstNonEmptyComment(comment, "Verification requested changes"),
		}, true
	default:
		return verificationPatch{}, false
	}
}

func firstNonEmptyComment(comment, fallback string) string {
	if comment != "" {
		return comment
	}
	return fallback
}
