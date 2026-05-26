package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"

	"github.com/xiaobei/codex-issue-runner/backend/internal/runner"
	"github.com/xiaobei/codex-issue-runner/backend/internal/store"
)

type runnerCommandRequest struct {
	SessionID  string                    `json:"session_id,omitempty"`
	Command    runnerCommandPayload      `json:"command"`
	Prompt     string                    `json:"prompt,omitempty"`
	References []runner.SessionReference `json:"references,omitempty"`
}

type runnerCommandPayload struct {
	Name                 string               `json:"name,omitempty"`
	Type                 string               `json:"type,omitempty"`
	Args                 map[string]any       `json:"args,omitempty"`
	Target               *runnerCommandTarget `json:"target,omitempty"`
	RequiresConfirmation bool                 `json:"requires_confirmation,omitempty"`
}

type runnerCommandTarget struct {
	Type string `json:"type,omitempty"`
	ID   string `json:"id,omitempty"`
}

type RunnerCommandResponse struct {
	Command              runnerCommandPayload `json:"command"`
	Summary              string               `json:"summary"`
	RequiresConfirmation bool                 `json:"requires_confirmation,omitempty"`
	Issue                *store.Issue         `json:"issue,omitempty"`
	Project              *store.Project       `json:"project,omitempty"`
	Runs                 []store.IssueRun     `json:"runs,omitempty"`
	System               systemStatus         `json:"system,omitempty"`
}

func (s *Server) handleCommands(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodPost) {
		return
	}
	var req runnerCommandRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "请求体不是合法 JSON")
		return
	}
	res, err := s.executeRunnerCommand(r, req)
	if err != nil {
		handleCommandError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, res)
}

func (s *Server) executeRunnerCommand(r *http.Request, req runnerCommandRequest) (RunnerCommandResponse, error) {
	cmd := normalizeRunnerCommand(req.Command)
	req.Command = cmd
	res, err := s.executeRunnerCommandAction(r, req, cmd)
	if saveErr := s.saveCommandEvent(r, req, cmd, res, err); saveErr != nil && err == nil {
		return RunnerCommandResponse{}, saveErr
	}
	return res, err
}

func (s *Server) executeRunnerCommandAction(r *http.Request, req runnerCommandRequest, cmd runnerCommandPayload) (RunnerCommandResponse, error) {
	switch cmd.Name {
	case "status":
		return s.statusCommand(r.Context(), cmd)
	case "issue":
		return s.issueCommand(r, req, cmd)
	case "run":
		return s.runCommand(r, cmd)
	default:
		return RunnerCommandResponse{}, commandBadRequest("unsupported command: " + cmd.Name)
	}
}

func normalizeRunnerCommand(cmd runnerCommandPayload) runnerCommandPayload {
	cmd.Name = strings.ToLower(strings.TrimSpace(firstNonEmpty(cmd.Name, cmd.Type)))
	if cmd.Args == nil {
		cmd.Args = map[string]any{}
	}
	return cmd
}

func (s *Server) statusCommand(ctx context.Context, cmd runnerCommandPayload) (RunnerCommandResponse, error) {
	res := RunnerCommandResponse{Command: cmd, Summary: "runner status", System: s.buildSystemStatus(ctx)}
	issueID := commandIssueID(cmd)
	if issueID == 0 {
		return res, nil
	}
	issue, err := s.store.GetIssue(ctx, issueID)
	if err != nil {
		return RunnerCommandResponse{}, err
	}
	res.Issue = &issue
	res.Summary = fmt.Sprintf("issue #%d is %s", issue.ID, issue.Status)
	project, err := s.projectForCommand(ctx, issue.ProjectID)
	if err != nil {
		return RunnerCommandResponse{}, err
	}
	res.Project = &project
	runs, err := s.store.ListIssueRuns(ctx, issue.ID)
	if err != nil {
		return RunnerCommandResponse{}, err
	}
	res.Runs = runs
	return res, nil
}

func (s *Server) issueCommand(r *http.Request, req runnerCommandRequest, cmd runnerCommandPayload) (RunnerCommandResponse, error) {
	sourceSessionID := commandSourceSessionID(req, cmd)
	projectID := firstNonEmpty(commandStringArg(cmd, "project_id"), projectIDFromRefs(req.References))
	if projectID == "" {
		return RunnerCommandResponse{}, commandBadRequest("/issue 需要选择 project")
	}
	description := issueCommandDescription(req, cmd)
	if description == "" {
		return RunnerCommandResponse{}, commandBadRequest("/issue 需要 prompt 或 description")
	}
	issue, err := s.store.CreateIssue(r.Context(), store.Issue{
		ProjectID: projectID, Title: commandStringArg(cmd, "title"), Description: description,
		Status: store.StatusTriage, SourceSessionID: sourceSessionID,
		SourceTurnID:  commandStringArg(cmd, "source_turn_id"),
		SourceExcerpt: firstNonEmpty(commandStringArg(cmd, "source_excerpt"), commandIssueSourceExcerpt(cmd, sourceSessionID)),
	})
	if err != nil {
		return RunnerCommandResponse{}, err
	}
	s.recordIssueEvent(r, issue.ID, "issue.created", nil)
	return RunnerCommandResponse{Command: cmd, Issue: &issue, Summary: fmt.Sprintf("created triage issue #%d", issue.ID)}, nil
}

func (s *Server) runCommand(r *http.Request, cmd runnerCommandPayload) (RunnerCommandResponse, error) {
	if !commandBoolArg(cmd, "confirmed") {
		return RunnerCommandResponse{}, commandBadRequest("/run 需要确认后才能 enqueue issue")
	}
	issueID := commandIssueID(cmd)
	if issueID == 0 {
		return RunnerCommandResponse{}, commandBadRequest("/run 需要 issue_id")
	}
	issue, err := s.store.GetIssue(r.Context(), issueID)
	if err != nil {
		return RunnerCommandResponse{}, err
	}
	project, err := s.runnableProjectForCommand(r.Context(), issue.ProjectID)
	if err != nil {
		return RunnerCommandResponse{}, err
	}
	updated, err := s.store.UpdateIssue(r.Context(), issue.ID, store.IssuePatch{Status: ptr(store.StatusTodo), Error: ptr(""), CodexThreadID: ptr(""), CodexTurnID: ptr("")})
	if err != nil {
		return RunnerCommandResponse{}, err
	}
	s.recordIssueEvent(r, issue.ID, "issue.status_changed", map[string]string{"status": store.StatusTodo})
	s.kickAutoProject(r, updated.ProjectID)
	return RunnerCommandResponse{Command: cmd, Issue: &updated, Project: &project, Summary: fmt.Sprintf("enqueued issue #%d as %s", updated.ID, updated.Status)}, nil
}

func (s *Server) projectForCommand(ctx context.Context, projectID string) (store.Project, error) {
	project, err := s.store.GetProject(ctx, projectID)
	if err != nil {
		return store.Project{}, err
	}
	project.LoopStatus = s.runner.LoopStatus(project.ID)
	store.AttachProjectCapability(&project)
	return project, nil
}

func (s *Server) runnableProjectForCommand(ctx context.Context, projectID string) (store.Project, error) {
	project, err := s.projectForCommand(ctx, projectID)
	if err != nil {
		return store.Project{}, err
	}
	if project.Provider != store.ProviderCodex {
		return store.Project{}, commandBadRequest("project " + project.ID + " provider \"" + project.Provider + "\" 暂不支持，当前只支持 codex")
	}
	if project.Hold != nil {
		return store.Project{}, commandBadRequest("project " + project.ID + " 处于 hold 状态: " + project.Hold.Message)
	}
	if err := s.runner.EnsureCleanWorktree(ctx, project.CWD); err != nil {
		return store.Project{}, commandBadRequest(err.Error())
	}
	return project, nil
}

func issueCommandDescription(req runnerCommandRequest, cmd runnerCommandPayload) string {
	body := firstNonEmpty(commandStringArg(cmd, "description"), commandStringArg(cmd, "body"), commandStringArg(cmd, "prompt"), req.Prompt)
	body = strings.TrimSpace(body)
	refs := commandReferences(req, cmd)
	if len(refs) == 0 {
		return body
	}
	lines := []string{body, "", "References:"}
	for _, ref := range refs {
		lines = append(lines, "- "+referenceCommandLine(ref))
	}
	return strings.TrimSpace(strings.Join(lines, "\n"))
}

func commandReferences(req runnerCommandRequest, cmd runnerCommandPayload) []runner.SessionReference {
	refs := append([]runner.SessionReference{}, req.References...)
	if raw, ok := cmd.Args["references"]; ok {
		b, _ := json.Marshal(raw)
		var extra []runner.SessionReference
		if json.Unmarshal(b, &extra) == nil {
			refs = append(refs, extra...)
		}
	}
	return refs
}

func referenceCommandLine(ref runner.SessionReference) string {
	value := firstNonEmpty(ref.ID, ref.Path, ref.Name, ref.Label)
	if value == "" {
		return strings.TrimSpace(ref.Type)
	}
	return strings.TrimSpace(ref.Type) + ":" + value
}

func projectIDFromRefs(refs []runner.SessionReference) string {
	for _, ref := range refs {
		if strings.TrimSpace(ref.Type) == "project" && strings.TrimSpace(ref.ID) != "" {
			return strings.TrimSpace(ref.ID)
		}
	}
	return ""
}

func commandIssueID(cmd runnerCommandPayload) int64 {
	if cmd.Target != nil && strings.TrimSpace(cmd.Target.Type) == "issue" {
		return parseCommandInt(cmd.Target.ID)
	}
	return firstPositiveInt(commandIntArg(cmd, "issue_id"), commandIntArg(cmd, "id"))
}

func commandStringArg(cmd runnerCommandPayload, key string) string {
	value, ok := cmd.Args[key]
	if !ok || value == nil {
		return ""
	}
	return strings.TrimSpace(fmt.Sprint(value))
}

func commandBoolArg(cmd runnerCommandPayload, key string) bool {
	value, ok := cmd.Args[key]
	if !ok {
		return false
	}
	b, ok := value.(bool)
	return ok && b
}

func commandIntArg(cmd runnerCommandPayload, key string) int64 {
	return parseCommandInt(commandStringArg(cmd, key))
}

func parseCommandInt(value any) int64 {
	n, err := strconv.ParseInt(strings.TrimSpace(fmt.Sprint(value)), 10, 64)
	if err != nil || n <= 0 {
		return 0
	}
	return n
}

func firstPositiveInt(values ...int64) int64 {
	for _, value := range values {
		if value > 0 {
			return value
		}
	}
	return 0
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if trimmed := strings.TrimSpace(value); trimmed != "" {
			return trimmed
		}
	}
	return ""
}

type commandBadRequest string

func (e commandBadRequest) Error() string { return string(e) }

func handleCommandError(w http.ResponseWriter, err error) {
	if _, ok := err.(commandBadRequest); ok {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	handleErr(w, err)
}
