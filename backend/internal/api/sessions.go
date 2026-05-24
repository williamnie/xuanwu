package api

import (
	"errors"
	"net/http"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/xiaobei/codex-issue-runner/backend/internal/agent"
	"github.com/xiaobei/codex-issue-runner/backend/internal/runner"
	"github.com/xiaobei/codex-issue-runner/backend/internal/store"
	codexusage "github.com/xiaobei/codex-issue-runner/backend/internal/usage"
)

type createSessionRequest struct {
	ProjectID       string `json:"project_id"`
	CWD             string `json:"cwd"`
	Model           string `json:"model"`
	ReasoningEffort string `json:"reasoning_effort"`
	ApprovalPolicy  string `json:"approval_policy"`
	Sandbox         string `json:"sandbox"`
	Prompt          string `json:"prompt"`
}

type sessionMessageRequest struct {
	Prompt          string `json:"prompt"`
	Model           string `json:"model"`
	ReasoningEffort string `json:"reasoning_effort"`
	ApprovalPolicy  string `json:"approval_policy"`
	Sandbox         string `json:"sandbox"`
}

type sessionDetailResponse struct {
	agent.Session
	Model       string                    `json:"model,omitempty"`
	LinkedIssue *linkedSessionIssue       `json:"linked_issue,omitempty"`
	TokenUsage  *codexusage.UsageSnapshot `json:"token_usage,omitempty"`
}

type linkedSessionIssue struct {
	ID     int64  `json:"id"`
	Title  string `json:"title"`
	Status string `json:"status"`
}

func (s *Server) routeSessions(w http.ResponseWriter, r *http.Request, parts []string) {
	if len(parts) == 1 {
		s.handleSessions(w, r)
		return
	}
	if len(parts) == 2 && parts[1] == "preferences" {
		s.handleSessionPreferences(w, r)
		return
	}
	if len(parts) == 2 {
		s.handleSession(w, r, parts[1])
		return
	}
	if len(parts) == 3 {
		s.handleSessionAction(w, r, parts[1], parts[2])
		return
	}
	writeError(w, http.StatusNotFound, "not found")
}

func (s *Server) handleSessions(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		s.listSessions(w, r)
	case http.MethodPost:
		s.createSession(w, r)
	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

func (s *Server) handleSession(w http.ResponseWriter, r *http.Request, threadID string) {
	if !requireMethod(w, r, http.MethodGet) {
		return
	}
	ref, ok := parseSessionRef(w, threadID)
	if !ok {
		return
	}
	session, err := s.runner.ReadSession(r.Context(), ref.SessionID)
	if err != nil {
		handleErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, s.enrichSessionDetail(r, session))
}

func (s *Server) handleSessionAction(w http.ResponseWriter, r *http.Request, threadID, action string) {
	if !requireMethod(w, r, http.MethodPost) {
		return
	}
	ref, ok := parseSessionRef(w, threadID)
	if !ok {
		return
	}
	switch action {
	case "messages":
		s.createSessionMessage(w, r, ref.SessionID)
	case "interrupt":
		s.interruptSession(w, r, ref.SessionID)
	default:
		writeError(w, http.StatusNotFound, "not found")
	}
}

func (s *Server) listSessions(w http.ResponseWriter, r *http.Request) {
	input := agent.SessionListInput{Cursor: r.URL.Query().Get("cursor"), Limit: parseSessionLimit(r)}
	result, err := s.runner.ListSessions(r.Context(), input)
	if err != nil {
		handleErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) createSession(w http.ResponseWriter, r *http.Request) {
	var req createSessionRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "请求体不是合法 JSON")
		return
	}
	result, err := s.runner.CreateSession(r.Context(), toSessionCreateInput(req))
	if err != nil {
		handleErr(w, err)
		return
	}
	if req.ProjectID != "" {
		if err := s.store.SetLastSessionProject(r.Context(), req.ProjectID); err != nil {
			handleErr(w, err)
			return
		}
	}
	writeJSON(w, http.StatusCreated, result)
}

func (s *Server) handleSessionPreferences(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodGet) {
		return
	}
	projectID, err := s.store.LastSessionProject(r.Context())
	if err != nil && !errors.Is(err, store.ErrNotFound) {
		handleErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, store.SessionPreferences{LastProjectID: projectID})
}

func (s *Server) createSessionMessage(w http.ResponseWriter, r *http.Request, threadID string) {
	var req sessionMessageRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "请求体不是合法 JSON")
		return
	}
	turnID, err := s.runner.StartSessionTurn(r.Context(), threadID, toSessionTurnInput(req))
	if err != nil {
		handleErr(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]string{"thread_id": threadID, "turn_id": turnID})
}

func (s *Server) interruptSession(w http.ResponseWriter, r *http.Request, threadID string) {
	result, err := s.runner.InterruptSession(r.Context(), threadID)
	if err != nil {
		handleErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func parseSessionLimit(r *http.Request) int {
	limit, err := strconv.Atoi(r.URL.Query().Get("limit"))
	if err != nil || limit <= 0 {
		return 50
	}
	if limit > 100 {
		return 100
	}
	return limit
}

func toSessionCreateInput(req createSessionRequest) runner.SessionCreateInput {
	return runner.SessionCreateInput{
		ProjectID: req.ProjectID, CWD: req.CWD, Model: req.Model, ReasoningEffort: req.ReasoningEffort,
		ApprovalPolicy: req.ApprovalPolicy, Sandbox: req.Sandbox, Prompt: req.Prompt,
	}
}

func toSessionTurnInput(req sessionMessageRequest) runner.SessionTurnInput {
	return runner.SessionTurnInput{
		Prompt: req.Prompt, Model: req.Model, ReasoningEffort: req.ReasoningEffort,
		ApprovalPolicy: req.ApprovalPolicy, Sandbox: req.Sandbox,
	}
}

type sessionRef struct {
	Provider  string
	SessionID string
}

func parseSessionRef(w http.ResponseWriter, raw string) (sessionRef, bool) {
	ref := parseSessionRefValue(raw)
	if ref.SessionID == "" {
		writeError(w, http.StatusBadRequest, "session id 不能为空")
		return sessionRef{}, false
	}
	if ref.Provider != store.ProviderCodex {
		writeError(w, http.StatusBadRequest, "session provider 暂不支持")
		return sessionRef{}, false
	}
	return ref, true
}

func parseSessionRefValue(raw string) sessionRef {
	value := strings.TrimSpace(raw)
	provider, sessionID, ok := strings.Cut(value, ":")
	if !ok {
		return sessionRef{Provider: store.ProviderCodex, SessionID: value}
	}
	return sessionRef{
		Provider:  strings.TrimSpace(provider),
		SessionID: strings.TrimSpace(sessionID),
	}
}

func (s *Server) enrichSessionDetail(r *http.Request, session agent.Session) sessionDetailResponse {
	meta, _ := codexusage.ReadSessionMetadata(r.Context(), s.sessionMetadataPath(session.Path))
	return sessionDetailResponse{
		Session:     session,
		Model:       meta.Model,
		LinkedIssue: s.linkedIssue(r, session.ProviderSessionID),
		TokenUsage:  meta.TokenUsage,
	}
}

func (s *Server) linkedIssue(r *http.Request, threadID string) *linkedSessionIssue {
	issue, err := s.store.GetIssueByCodexThreadID(r.Context(), threadID)
	if err != nil {
		return nil
	}
	return &linkedSessionIssue{ID: issue.ID, Title: issue.Title, Status: issue.Status}
}

func (s *Server) sessionMetadataPath(sessionPath string) string {
	if strings.TrimSpace(s.codexSessionsDir) == "" {
		return ""
	}
	if strings.TrimSpace(sessionPath) == "" {
		return ""
	}
	root, err := filepath.Abs(s.codexSessionsDir)
	if err != nil {
		return ""
	}
	target, err := filepath.Abs(strings.TrimSpace(sessionPath))
	if err != nil {
		return ""
	}
	rel, err := filepath.Rel(root, target)
	if err != nil || rel == ".." || strings.HasPrefix(rel, "../") {
		return ""
	}
	return target
}
