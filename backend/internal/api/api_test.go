package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/textproto"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"github.com/xiaobei/codex-issue-runner/backend/internal/agent"
	"github.com/xiaobei/codex-issue-runner/backend/internal/events"
	"github.com/xiaobei/codex-issue-runner/backend/internal/runner"
	"github.com/xiaobei/codex-issue-runner/backend/internal/store"
)

type noopCodex struct {
	ch               chan agent.Event
	listInput        *agent.SessionListInput
	pendingApprovals []agent.PendingApproval
}

func (n noopCodex) Name() string                { return "codex" }
func (n noopCodex) Start(context.Context) error { return nil }
func (n noopCodex) Stop(context.Context) error  { return nil }
func (n noopCodex) StartThread(context.Context, agent.ThreadInput) (string, error) {
	return "thread-new", nil
}
func (n noopCodex) ListModels(context.Context, agent.ModelListInput) (agent.ModelListResult, error) {
	return agent.ModelListResult{Data: []agent.Model{{
		ID: "gpt-5.5", Model: "gpt-5.5", DisplayName: "GPT-5.5",
		DefaultReasoningEffort:    "xhigh",
		SupportedReasoningEfforts: []agent.ReasoningEffortOption{{ReasoningEffort: "xhigh", Description: "超高"}},
	}}}, nil
}
func (n noopCodex) ListThreads(_ context.Context, input agent.SessionListInput) (agent.SessionListResult, error) {
	if n.listInput != nil {
		*n.listInput = input
	}
	return agent.SessionListResult{Data: []agent.Session{{ID: "thread-1", CWD: "/tmp/demo", Preview: "hello"}}, NextCursor: "next"}, nil
}
func (n noopCodex) ReadThread(context.Context, string) (agent.Session, error) {
	return agent.Session{ID: "thread-1", CWD: "/tmp/demo", Preview: "hello"}, nil
}
func (n noopCodex) ResumeThread(context.Context, string) (agent.Session, error) {
	return agent.Session{ID: "thread-1", CWD: "/tmp/demo"}, nil
}
func (n noopCodex) SetThreadName(context.Context, string, string) error { return nil }
func (n noopCodex) StartTurn(context.Context, string, []agent.UserInput, agent.TurnOptions) (string, error) {
	return "turn-new", nil
}
func (n noopCodex) InterruptTurn(context.Context, string, string) error { return nil }
func (n noopCodex) ResolveApproval(context.Context, string, agent.ApprovalDecision) error {
	return nil
}
func (n noopCodex) PendingApprovals(context.Context) ([]agent.PendingApproval, error) {
	return n.pendingApprovals, nil
}
func (n noopCodex) Events() <-chan agent.Event { return n.ch }

type holdResumeCodex struct {
	events       chan agent.Event
	autoComplete bool
	startErr     error
}

type projectHoldResumeConflict struct {
	Message string        `json:"message"`
	Project store.Project `json:"project"`
}

func (h *holdResumeCodex) Name() string { return "codex" }
func (h *holdResumeCodex) Start(context.Context) error {
	return h.startErr
}
func (h *holdResumeCodex) StartThread(context.Context, agent.ThreadInput) (string, error) {
	return "thread-hold", nil
}
func (h *holdResumeCodex) StartTurn(
	_ context.Context,
	threadID string,
	_ []agent.UserInput,
	_ agent.TurnOptions,
) (string, error) {
	turnID := "turn-hold"
	if h.autoComplete {
		go func() {
			h.events <- agent.Event{
				Type: events.AgentTurnCompleted, ThreadID: threadID,
				TurnID: turnID, Status: "completed",
			}
		}()
	}
	return turnID, nil
}
func (h *holdResumeCodex) Events() <-chan agent.Event {
	if h.events == nil {
		h.events = make(chan agent.Event, 4)
	}
	return h.events
}

func TestProjectAndIssueAPI(t *testing.T) {
	srv := newTestServer(t)
	project := postJSON[store.Project](t, srv, "/api/projects", map[string]any{
		"id": "demo", "name": "Demo", "cwd": t.TempDir(), "auto_run": 0,
	})
	if project.ID != "demo" || project.LoopStatus != "stopped" {
		t.Fatalf("unexpected project: %+v", project)
	}
	issue := postJSON[store.Issue](t, srv, "/api/issues", map[string]any{
		"project_id": "demo", "description": "Fix bug from content", "status": "triage",
	})
	if issue.ID == 0 || issue.Status != "triage" {
		t.Fatalf("unexpected issue: %+v", issue)
	}
	if issue.Title != "Fix bug from content" {
		t.Fatalf("expected derived title, got %+v", issue)
	}
	enqueued := postJSON[store.Issue](t, srv, "/api/issues/1/enqueue", map[string]any{})
	if enqueued.Status != store.StatusTodo {
		t.Fatalf("enqueue status: %+v", enqueued)
	}
	events := getJSON[[]store.IssueEvent](t, srv, "/api/issues/1/events")
	if len(events) < 2 {
		t.Fatalf("expected created/status events: %+v", events)
	}
}

func TestIssueCommentAPIAppendsEvent(t *testing.T) {
	srv := newTestServer(t)
	postJSON[store.Project](t, srv, "/api/projects", map[string]any{
		"id": "demo", "name": "Demo", "cwd": t.TempDir(), "auto_run": 0,
	})
	issue := postJSON[store.Issue](t, srv, "/api/issues", map[string]any{
		"project_id": "demo", "title": "Discuss task", "description": "keep me", "status": "triage",
	})
	ch, unsubscribe := srv.bus.Subscribe()
	defer unsubscribe()

	event := postJSON[store.IssueEvent](t, srv, "/api/issues/1/comments", map[string]any{
		"body": "**验收**: 保留 description", "author": "user",
	})
	if event.Type != "issue.comment" || event.IssueID != issue.ID {
		t.Fatalf("unexpected comment event: %+v", event)
	}
	var payload map[string]string
	if err := json.Unmarshal([]byte(event.Payload), &payload); err != nil {
		t.Fatalf("decode payload: %v payload=%s", err, event.Payload)
	}
	if payload["author"] != "user" || payload["body"] != "**验收**: 保留 description" {
		t.Fatalf("unexpected payload: %+v", payload)
	}

	updated := getJSON[store.Issue](t, srv, "/api/issues/1")
	if updated.Description != "keep me" {
		t.Fatalf("comment must not overwrite description: %+v", updated)
	}
	if updated.CommentCount != 1 {
		t.Fatalf("expected comment_count=1 after comment, got %+v", updated)
	}
	issueEvents := getJSON[[]store.IssueEvent](t, srv, "/api/issues/1/events")
	if issueEvents[len(issueEvents)-1].ID != event.ID || issueEvents[len(issueEvents)-1].Type != "issue.comment" {
		t.Fatalf("comment not appended to events: %+v", issueEvents)
	}

	var published events.AppEvent
	select {
	case published = <-ch:
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for issue.comment SSE event")
	}
	if published.Type != "issue.comment" || published.IssueID != issue.ID || published.Payload == "" {
		t.Fatalf("unexpected SSE event: %+v", published)
	}
}

func TestIssueAPIPersistsSourceSessionMetadata(t *testing.T) {
	srv := newTestServer(t)
	postJSON[store.Project](t, srv, "/api/projects", map[string]any{
		"id": "demo", "name": "Demo", "cwd": t.TempDir(), "auto_run": 0,
	})
	issue := postJSON[store.Issue](t, srv, "/api/issues", map[string]any{
		"project_id": "demo", "title": "Follow up", "description": "从讨论创建",
		"status": "triage", "source_session_id": "codex:thread-source",
		"source_turn_id": "turn-source", "source_excerpt": "讨论摘录",
		"codex_thread_id": "must-not-be-runtime",
	})
	if issue.SourceSessionID != "thread-source" || issue.SourceTurnID != "turn-source" ||
		issue.SourceExcerpt != "讨论摘录" {
		t.Fatalf("source metadata mismatch: %+v", issue)
	}
	if issue.CodexThreadID != "" {
		t.Fatalf("source create must not populate execution runtime: %+v", issue)
	}
	listed := getJSON[[]store.Issue](t, srv, "/api/issues?sourceSessionId=codex:thread-source")
	if len(listed) != 1 || listed[0].ID != issue.ID {
		t.Fatalf("source session filter mismatch: %+v", listed)
	}
}

func TestIssueCommentAPIRejectsEmptyBody(t *testing.T) {
	srv := newTestServer(t)
	postJSON[store.Project](t, srv, "/api/projects", map[string]any{
		"id": "demo", "name": "Demo", "cwd": t.TempDir(), "auto_run": 0,
	})
	postJSON[store.Issue](t, srv, "/api/issues", map[string]any{
		"project_id": "demo", "title": "Discuss task", "status": "triage",
	})

	b, _ := json.Marshal(map[string]any{"body": " \n\t ", "author": "user"})
	req := httptest.NewRequest(http.MethodPost, "/api/issues/1/comments", bytes.NewReader(b))
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()
	srv.ServeHTTP(rr, req)
	if rr.Code != http.StatusBadRequest || !strings.Contains(rr.Body.String(), "评论内容不能为空") {
		t.Fatalf("empty comment status=%d body=%s", rr.Code, rr.Body.String())
	}
}

func TestProjectHoldStatusAPI(t *testing.T) {
	srv := newTestServer(t)
	project := postJSON[store.Project](t, srv, "/api/projects", map[string]any{
		"id": "demo", "name": "Demo", "cwd": t.TempDir(), "auto_run": 0,
	})
	held, err := srv.store.SetProjectHold(context.Background(), project.ID, store.ProjectHold{
		Reason:         "usage_limit",
		Message:        "Runner paused: usage limit reached",
		NextCheckAt:    "2026-05-23T12:00:00Z",
		LastCheckError: "still limited",
	})
	if err != nil || held.Hold == nil {
		t.Fatalf("seed hold: %+v err=%v", held, err)
	}

	got := getJSON[store.Project](t, srv, "/api/projects/demo")
	if got.Hold == nil || got.Hold.Reason != "usage_limit" || got.Hold.LastCheckError != "still limited" {
		t.Fatalf("GET project should expose hold: %+v", got)
	}
	status := getJSON[store.ProjectHold](t, srv, "/api/projects/demo/hold/status")
	if status.Message != "Runner paused: usage limit reached" {
		t.Fatalf("hold status = %+v", status)
	}
	cleared := postJSON[store.Project](t, srv, "/api/projects/demo/hold/clear", map[string]any{})
	if cleared.Hold != nil {
		t.Fatalf("clear hold should return project without hold: %+v", cleared)
	}
}

func TestProjectHoldResumeAPIHealthChecksBeforeClearing(t *testing.T) {
	provider := &holdResumeCodex{events: make(chan agent.Event, 4), autoComplete: true}
	srv := newTestServerWithCodex(t, provider)
	project := postJSON[store.Project](t, srv, "/api/projects", map[string]any{
		"id": "demo", "name": "Demo", "cwd": t.TempDir(), "auto_run": 0,
	})
	one := 1
	if _, err := srv.store.UpdateProject(context.Background(), project.ID, store.ProjectPatch{AutoRun: &one}); err != nil {
		t.Fatalf("enable auto run: %v", err)
	}
	_, err := srv.store.SetProjectHold(context.Background(), project.ID, store.ProjectHold{
		Reason: "authentication", Message: "Runner paused: authentication failed",
	})
	if err != nil {
		t.Fatalf("seed hold: %v", err)
	}
	t.Cleanup(func() { srv.runner.StopProject(project.ID) })

	resumed := postJSON[store.Project](t, srv, "/api/projects/demo/hold/resume", map[string]any{})
	if resumed.Hold != nil || resumed.LoopStatus != "running" {
		t.Fatalf("resume should clear hold and restart auto loop: %+v", resumed)
	}
}

func TestProjectHoldResumeAPIKeepsHoldWhenHealthCheckFails(t *testing.T) {
	provider := &holdResumeCodex{
		events:   make(chan agent.Event, 4),
		startErr: errors.New("API returned 401: expired token"),
	}
	srv := newTestServerWithCodex(t, provider)
	project := postJSON[store.Project](t, srv, "/api/projects", map[string]any{
		"id": "demo", "name": "Demo", "cwd": t.TempDir(), "auto_run": 0,
	})
	_, err := srv.store.SetProjectHold(context.Background(), project.ID, store.ProjectHold{
		Reason: "authentication", Message: "Runner paused: authentication failed",
	})
	if err != nil {
		t.Fatalf("seed hold: %v", err)
	}

	body := postProjectHoldResumeConflict(t, srv, "/api/projects/demo/hold/resume")
	if !strings.Contains(body.Message, "expired token") {
		t.Fatalf("resume conflict should expose failure reason: %+v", body)
	}
	if body.Project.Hold == nil || !strings.Contains(body.Project.Hold.LastCheckError, "expired token") {
		t.Fatalf("failed resume should keep hold with check error: %+v", body.Project)
	}
}

func TestProjectOrderAPI(t *testing.T) {
	srv := newTestServer(t)
	for _, id := range []string{"alpha", "beta", "gamma"} {
		postJSON[store.Project](t, srv, "/api/projects", map[string]any{
			"id": id, "name": id, "cwd": filepath.Join(t.TempDir(), id),
		})
	}

	ordered := patchJSON[[]store.Project](t, srv, "/api/projects", map[string]any{
		"project_ids": []string{"gamma", "alpha", "beta"},
	})
	assertAPIProjectOrder(t, ordered, []string{"gamma", "alpha", "beta"})

	listed := getJSON[[]store.Project](t, srv, "/api/projects")
	assertAPIProjectOrder(t, listed, []string{"gamma", "alpha", "beta"})
}

func TestIssueTemplateAPIAndIssueSelection(t *testing.T) {
	srv := newTestServer(t)
	templates := getJSON[[]store.IssueTemplate](t, srv, "/api/issue-templates")
	if len(templates) != 1 || templates[0].ID != store.DefaultIssueTemplateID || templates[0].IsDefault != 1 {
		t.Fatalf("unexpected seeded templates: %+v", templates)
	}
	custom := postJSON[store.IssueTemplate](t, srv, "/api/issue-templates", map[string]any{
		"name":    "最小修复",
		"content": "路径={{project.cwd}}\n任务={{issue.title}}\n",
	})
	if custom.ID == "" || custom.Content == "" {
		t.Fatalf("unexpected custom template: %+v", custom)
	}
	patched := patchJSON[store.IssueTemplate](t, srv, "/api/issue-templates/"+custom.ID, map[string]any{
		"is_default": 1,
	})
	if patched.IsDefault != 1 {
		t.Fatalf("default flag not updated: %+v", patched)
	}
	_ = postJSON[store.Project](t, srv, "/api/projects", map[string]any{
		"id": "demo", "name": "Demo", "cwd": t.TempDir(), "auto_run": 0,
	})
	issue := postJSON[store.Issue](t, srv, "/api/issues", map[string]any{
		"project_id": "demo", "title": "Fix bug", "status": "triage", "template_id": custom.ID,
	})
	if issue.TemplateID != custom.ID || issue.PromptTemplate != custom.Content {
		t.Fatalf("issue did not use selected template: %+v template=%+v", issue, custom)
	}
}

func TestSessionAPI(t *testing.T) {
	var listInput agent.SessionListInput
	srv := newTestServerWithCodex(t, noopCodex{ch: make(chan agent.Event), listInput: &listInput})
	models := getJSON[agent.ModelListResult](t, srv, "/api/codex/models")
	if len(models.Data) != 1 || models.Data[0].ID != "gpt-5.5" {
		t.Fatalf("unexpected models: %+v", models)
	}
	list := getJSON[agent.SessionListResult](t, srv, "/api/sessions?limit=20&cursor=abc")
	if len(list.Data) != 1 || list.Data[0].ID != "codex:thread-1" ||
		list.Data[0].Provider != store.ProviderCodex ||
		list.Data[0].ProviderSessionID != "thread-1" || list.NextCursor != "next" {
		t.Fatalf("unexpected sessions: %+v", list)
	}
	if listInput.Limit != 20 || listInput.Cursor != "abc" {
		t.Fatalf("session list input = %+v", listInput)
	}
	created := postJSON[runner.SessionCreateResult](t, srv, "/api/sessions", map[string]any{
		"cwd": t.TempDir(), "prompt": "hello",
	})
	if created.ID != "codex:thread-new" || created.Provider != store.ProviderCodex ||
		created.ProviderSessionID != "thread-new" || created.ProviderTurnID != "turn-new" ||
		created.ThreadID != "thread-new" || created.TurnID != "turn-new" {
		t.Fatalf("unexpected created session: %+v", created)
	}
}

func TestSessionDetailIncludesPendingApprovals(t *testing.T) {
	srv := newTestServerWithCodex(t, noopCodex{
		ch: make(chan agent.Event),
		pendingApprovals: []agent.PendingApproval{{
			ID: "approval-1", Method: "item/commandExecution/requestApproval",
			ThreadID: "thread-1", TurnID: "turn-1", Params: map[string]any{"command": "go test ./..."},
		}},
	})

	detail := getJSON[sessionDetailResponse](t, srv, "/api/sessions/codex:thread-1")
	if len(detail.PendingApprovals) != 1 || detail.PendingApprovals[0].ID != "approval-1" ||
		detail.PendingApprovals[0].ThreadID != "thread-1" || !detail.IsRunning {
		t.Fatalf("session detail pending approvals = %+v", detail)
	}
}

func TestSessionDetailIncludesLinkedIssueAndMetadata(t *testing.T) {
	root := t.TempDir()
	sessionPath := filepath.Join(root, "session.jsonl")
	if err := os.WriteFile(sessionPath, []byte(strings.Join([]string{
		`{"timestamp":"2026-05-22T08:00:00Z","type":"turn_context","payload":{"model":"gpt-5.5"}}`,
		`{"timestamp":"2026-05-22T08:01:00Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"total_tokens":120},"last_token_usage":{"total_tokens":40},"model_context_window":258400}}}`,
	}, "\n")+"\n"), 0o644); err != nil {
		t.Fatalf("write session jsonl: %v", err)
	}
	srv := newTestServerWithCodex(t, sessionDetailCodex{
		noopCodex: noopCodex{ch: make(chan agent.Event)},
		path:      sessionPath,
	})
	srv.codexSessionsDir = root
	if _, err := srv.store.CreateProject(context.Background(), store.Project{ID: "demo", CWD: t.TempDir()}); err != nil {
		t.Fatalf("create project: %v", err)
	}
	issue, err := srv.store.CreateIssue(context.Background(), store.Issue{
		ProjectID: "demo", Title: "Session info", Status: store.StatusTodo,
	})
	if err != nil {
		t.Fatalf("create issue: %v", err)
	}
	if err := srv.store.UpdateIssueRuntime(context.Background(), issue.ID, "thread-1", "turn-1"); err != nil {
		t.Fatalf("update runtime: %v", err)
	}

	detail := getJSON[sessionDetailResponse](t, srv, "/api/sessions/codex:thread-1")
	if detail.Model != "gpt-5.5" || detail.TokenUsage == nil ||
		detail.TokenUsage.TotalTokenUsage.TotalTokens != 120 {
		t.Fatalf("missing session metadata: %+v", detail)
	}
	if detail.LinkedIssue == nil || detail.LinkedIssue.ID != issue.ID ||
		detail.LinkedIssue.Title != "Session info" || detail.LinkedIssue.Status != store.StatusTodo {
		t.Fatalf("missing linked issue: %+v", detail.LinkedIssue)
	}

	unlinked := getJSON[sessionDetailResponse](t, srv, "/api/sessions/codex:thread-free")
	if unlinked.LinkedIssue != nil || unlinked.TokenUsage != nil || unlinked.Model != "" {
		t.Fatalf("unlinked session should degrade cleanly: %+v", unlinked)
	}
}

func TestSessionDetailSeparatesSourceIssuesFromLinkedIssue(t *testing.T) {
	srv := newTestServerWithCodex(t, sessionDetailCodex{
		noopCodex: noopCodex{ch: make(chan agent.Event)},
	})
	if _, err := srv.store.CreateProject(context.Background(), store.Project{ID: "demo", CWD: t.TempDir()}); err != nil {
		t.Fatalf("create project: %v", err)
	}
	sourceIssue, err := srv.store.CreateIssue(context.Background(), store.Issue{
		ProjectID: "demo", Title: "Follow-up issue", Status: store.StatusTriage,
		SourceSessionID: "thread-1", SourceTurnID: "turn-discussion", SourceExcerpt: "讨论摘录",
	})
	if err != nil {
		t.Fatalf("create source issue: %v", err)
	}
	linkedIssue, err := srv.store.CreateIssue(context.Background(), store.Issue{
		ProjectID: "demo", Title: "Runner issue", Status: store.StatusTodo,
	})
	if err != nil {
		t.Fatalf("create linked issue: %v", err)
	}
	if err := srv.store.UpdateIssueRuntime(context.Background(), linkedIssue.ID, "thread-1", "turn-run"); err != nil {
		t.Fatalf("update runtime: %v", err)
	}

	detail := getJSON[sessionDetailResponse](t, srv, "/api/sessions/codex:thread-1")
	if detail.LinkedIssue == nil || detail.LinkedIssue.ID != linkedIssue.ID {
		t.Fatalf("linked issue should still mean execution session: %+v", detail.LinkedIssue)
	}
	if len(detail.SourceIssues) != 1 || detail.SourceIssues[0].ID != sourceIssue.ID {
		t.Fatalf("source issues not returned separately: %+v", detail.SourceIssues)
	}
	if detail.SourceIssues[0].SourceTurnID != "turn-discussion" ||
		detail.SourceIssues[0].SourceExcerpt != "讨论摘录" {
		t.Fatalf("source issue metadata missing: %+v", detail.SourceIssues[0])
	}
}

func TestSystemStatusAPI(t *testing.T) {
	srv := newTestServer(t)
	postJSON[store.Project](t, srv, "/api/projects", map[string]any{
		"id": "demo", "name": "Demo", "cwd": t.TempDir(), "auto_run": 1,
	})
	postJSON[store.Issue](t, srv, "/api/issues", map[string]any{
		"project_id": "demo", "title": "running", "status": store.StatusInProgress,
	})
	srv.SetAuthToken("secret-token")
	srv.SetSystemConfig(SystemConfig{
		Addr: "127.0.0.1:3008", DBPath: "/tmp/app.db", CodexCmd: "missing-codex-for-test",
		CodexSessionsDir: "/tmp/sessions", AuthEnabled: true, WebMode: "embedded",
	})

	req := httptest.NewRequest(http.MethodGet, "/api/system/status", nil)
	req.Header.Set("Authorization", "Bearer secret-token")
	status := decodeResponse[systemStatus](t, srv, req, http.StatusOK)

	if !status.Service.Alive || !status.DB.OK || !status.Config.AuthEnabled {
		t.Fatalf("unexpected service/db/auth status: %+v", status)
	}
	if status.Config.DBPath != "/tmp/app.db" || status.Config.CodexCmd != "missing-codex-for-test" {
		t.Fatalf("config leaked or missing fields: %+v", status.Config)
	}
	if status.Codex.CommandOK || status.Codex.CommandError == "" {
		t.Fatalf("missing codex command should be explicit: %+v", status.Codex)
	}
	if status.Runner.AutoRunProjects != 1 || status.Runner.InProgressIssues != 1 {
		t.Fatalf("runner counts mismatch: %+v", status.Runner)
	}
}

type sessionDetailCodex struct {
	noopCodex
	path string
}

func (c sessionDetailCodex) ResumeThread(_ context.Context, threadID string) (agent.Session, error) {
	path := ""
	if threadID == "thread-1" {
		path = c.path
	}
	return agent.Session{ID: threadID, CWD: "/tmp/demo", Path: path}, nil
}

func TestSystemStatusRouteAccessibleWithAuth(t *testing.T) {
	srv := newTestServer(t)
	srv.SetAuthToken("secret-token")
	req := httptest.NewRequest(http.MethodGet, "/api/system/status", nil)
	rr := httptest.NewRecorder()
	srv.ServeHTTP(rr, req)
	if rr.Code != http.StatusUnauthorized {
		t.Fatalf("expected auth guard, got %d body=%s", rr.Code, rr.Body.String())
	}
	req = httptest.NewRequest(http.MethodGet, "/api/system/status", nil)
	req.Header.Set("Authorization", "Bearer secret-token")
	rr = httptest.NewRecorder()
	srv.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("expected auth success, got %d body=%s", rr.Code, rr.Body.String())
	}
}

func TestSessionAPIRemembersLastProject(t *testing.T) {
	srv := newTestServer(t)
	project := postJSON[store.Project](t, srv, "/api/projects", map[string]any{
		"id": "demo", "cwd": t.TempDir(),
	})
	initial := getJSON[store.SessionPreferences](t, srv, "/api/sessions/preferences")
	if initial.LastProjectID != "" {
		t.Fatalf("initial preferences = %+v", initial)
	}
	_ = postJSON[runner.SessionCreateResult](t, srv, "/api/sessions", map[string]any{
		"project_id": project.ID, "prompt": "hello",
	})
	got := getJSON[store.SessionPreferences](t, srv, "/api/sessions/preferences")
	if got.LastProjectID != "demo" {
		t.Fatalf("preferences = %+v, want demo", got)
	}
}

func TestImageUploadAPIStoresAndServesImage(t *testing.T) {
	srv := newTestServer(t)
	body, contentType := multipartBody(t, "file", "screenshot.png", "image/png",
		[]byte("\x89PNG\r\n\x1a\nfake image bytes"))
	req := httptest.NewRequest(http.MethodPost, "/api/uploads/images", body)
	req.Header.Set("Content-Type", contentType)
	upload := decodeResponse[store.Upload](t, srv, req, http.StatusCreated)
	if upload.ID == "" || upload.OriginalName != "screenshot.png" ||
		upload.MimeType != "image/png" || upload.SizeBytes == 0 {
		t.Fatalf("unexpected upload response: %+v", upload)
	}
	if !strings.HasPrefix(upload.URL, "/api/uploads/") {
		t.Fatalf("upload url should point to api content endpoint: %+v", upload)
	}

	getReq := httptest.NewRequest(http.MethodGet, "/api/uploads/"+upload.ID+"/content", nil)
	rr := httptest.NewRecorder()
	srv.ServeHTTP(rr, getReq)
	if rr.Code != http.StatusOK {
		t.Fatalf("GET upload status=%d body=%s", rr.Code, rr.Body.String())
	}
	if got := rr.Header().Get("Content-Type"); got != "image/png" {
		t.Fatalf("content-type = %q", got)
	}
	if !bytes.Contains(rr.Body.Bytes(), []byte("fake image bytes")) {
		t.Fatalf("served body mismatch: %q", rr.Body.String())
	}
}

func TestWebDirServesSPAWithoutShadowingAPI(t *testing.T) {
	webDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(webDir, "index.html"), []byte("<main>runner ui</main>"), 0o644); err != nil {
		t.Fatalf("write index: %v", err)
	}
	assetsDir := filepath.Join(webDir, "assets")
	if err := os.Mkdir(assetsDir, 0o755); err != nil {
		t.Fatalf("mkdir assets: %v", err)
	}
	if err := os.WriteFile(filepath.Join(assetsDir, "app.js"), []byte("console.log('ok')"), 0o644); err != nil {
		t.Fatalf("write asset: %v", err)
	}

	srv := newTestServerWithWeb(t, webDir)
	assertBodyContains(t, srv, "/", "runner ui")
	assertBodyContains(t, srv, "/assets/app.js", "console.log")
	assertBodyContains(t, srv, "/issues/42", "runner ui")

	req := httptest.NewRequest(http.MethodGet, "/api/nope", nil)
	rr := httptest.NewRecorder()
	srv.ServeHTTP(rr, req)
	if rr.Code != http.StatusNotFound || strings.Contains(rr.Body.String(), "runner ui") {
		t.Fatalf("API should keep JSON 404, status=%d body=%s", rr.Code, rr.Body.String())
	}
}

func TestEmbeddedSPAFSServesFallback(t *testing.T) {
	webFS := fstest.MapFS{
		"index.html":    {Data: []byte("<main>embedded ui</main>")},
		"assets/app.js": {Data: []byte("console.log('embedded')")},
	}
	srv := newTestServerWithWebHandler(t, newFSSPAHandler(webFS))

	assertBodyContains(t, srv, "/", "embedded ui")
	assertBodyContains(t, srv, "/assets/app.js", "embedded")
	assertBodyContains(t, srv, "/sessions/thread-1", "embedded ui")

	req := httptest.NewRequest(http.MethodGet, "/api/nope", nil)
	rr := httptest.NewRecorder()
	srv.ServeHTTP(rr, req)
	if rr.Code != http.StatusNotFound || strings.Contains(rr.Body.String(), "embedded ui") {
		t.Fatalf("API should keep JSON 404, status=%d body=%s", rr.Code, rr.Body.String())
	}
}

type projectSyncTestResponse struct {
	Source  string `json:"source"`
	Summary struct {
		Discovered int `json:"discovered"`
		Created    int `json:"created"`
		Existing   int `json:"existing"`
		Skipped    int `json:"skipped"`
	} `json:"summary"`
	Created  []store.Project `json:"created"`
	Existing []store.Project `json:"existing"`
	Skipped  []struct {
		CWD    string `json:"cwd"`
		Reason string `json:"reason"`
	} `json:"skipped"`
}

func TestSyncCodexProjectsCreatesMissingWorkspaceRoots(t *testing.T) {
	srv := newTestServer(t)
	root := t.TempDir()
	existingPath := filepath.Join(root, "movo-web")
	newPath := filepath.Join(root, "mindnote")
	missingPath := filepath.Join(root, "missing")
	if err := os.Mkdir(existingPath, 0o755); err != nil {
		t.Fatalf("mkdir existing: %v", err)
	}
	if err := os.Mkdir(newPath, 0o755); err != nil {
		t.Fatalf("mkdir new: %v", err)
	}
	postJSON[store.Project](t, srv, "/api/projects", map[string]any{
		"id": "movo-web", "name": "movo-web", "cwd": existingPath, "auto_run": 1,
	})
	statePath := filepath.Join(root, "codex-state.json")
	writeCodexState(t, statePath, existingPath, newPath, missingPath)
	t.Setenv("CODEX_RUNNER_CODEX_STATE", statePath)

	result := postJSON[projectSyncTestResponse](t, srv, "/api/projects/sync/codex", map[string]any{})
	if result.Source != statePath {
		t.Fatalf("source mismatch: %+v", result)
	}
	if result.Summary.Discovered != 4 || result.Summary.Created != 1 ||
		result.Summary.Existing != 1 || result.Summary.Skipped != 2 {
		t.Fatalf("unexpected summary: %+v", result.Summary)
	}
	if len(result.Created) != 1 || result.Created[0].CWD != newPath ||
		result.Created[0].AutoRun != 0 || result.Created[0].Model != "codex-default" {
		t.Fatalf("unexpected created project: %+v", result.Created)
	}

	again := postJSON[projectSyncTestResponse](t, srv, "/api/projects/sync/codex", map[string]any{})
	if again.Summary.Created != 0 || again.Summary.Existing != 2 || again.Summary.Skipped != 2 {
		t.Fatalf("sync should be idempotent: %+v", again.Summary)
	}
}

func writeCodexState(t *testing.T, path, existingPath, newPath, missingPath string) {
	t.Helper()
	state := map[string]any{
		"electron-saved-workspace-roots": []string{existingPath, newPath, missingPath},
		"remote-projects": []map[string]string{
			{"hostId": "remote-ssh-discovered:claw", "remotePath": "/home/xiaobei/project"},
		},
	}
	body, err := json.Marshal(state)
	if err != nil {
		t.Fatalf("marshal state: %v", err)
	}
	if err := os.WriteFile(path, body, 0o644); err != nil {
		t.Fatalf("write state: %v", err)
	}
}

func assertAPIProjectOrder(t *testing.T, projects []store.Project, want []string) {
	t.Helper()
	if len(projects) != len(want) {
		t.Fatalf("project count = %d, want %d: %+v", len(projects), len(want), projects)
	}
	for index, project := range projects {
		if project.ID != want[index] {
			t.Fatalf("project order = %+v, want %v", apiProjectIDs(projects), want)
		}
	}
}

func apiProjectIDs(projects []store.Project) []string {
	ids := make([]string, 0, len(projects))
	for _, project := range projects {
		ids = append(ids, project.ID)
	}
	return ids
}

func newTestServer(t *testing.T) *Server {
	return newTestServerWithWeb(t, "")
}

func newTestServerWithWeb(t *testing.T, webDir string) *Server {
	t.Helper()
	return newTestServerWithWebHandler(t, newWebHandler(webDir))
}

func newTestServerWithWebHandler(t *testing.T, web http.Handler) *Server {
	t.Helper()
	srv := newTestServerWithCodex(t, noopCodex{ch: make(chan agent.Event)})
	srv.web = web
	return srv
}

func newTestServerWithCodex(t *testing.T, provider agent.AgentProvider) *Server {
	t.Helper()
	st, err := store.Open(filepath.Join(t.TempDir(), "app.db"))
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })
	bus := events.NewBus()
	r := runner.New(st, bus, provider)
	return NewServerWithWebDir(st, bus, r, "")
}

func assertBodyContains(t *testing.T, h http.Handler, path, want string) {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, path, nil)
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK || !strings.Contains(rr.Body.String(), want) {
		t.Fatalf("GET %s status=%d body=%s want=%q", path, rr.Code, rr.Body.String(), want)
	}
}

func postJSON[T any](t *testing.T, h http.Handler, path string, body any) T {
	t.Helper()
	b, _ := json.Marshal(body)
	req := httptest.NewRequest(http.MethodPost, path, bytes.NewReader(b))
	req.Header.Set("Content-Type", "application/json")
	return decodeResponse[T](t, h, req, http.StatusCreated, http.StatusOK)
}

func getJSON[T any](t *testing.T, h http.Handler, path string) T {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, path, nil)
	return decodeResponse[T](t, h, req, http.StatusOK)
}

func patchJSON[T any](t *testing.T, h http.Handler, path string, body any) T {
	t.Helper()
	b, _ := json.Marshal(body)
	req := httptest.NewRequest(http.MethodPatch, path, bytes.NewReader(b))
	req.Header.Set("Content-Type", "application/json")
	return decodeResponse[T](t, h, req, http.StatusOK)
}

func postProjectHoldResumeConflict(t *testing.T, h http.Handler, path string) projectHoldResumeConflict {
	t.Helper()
	b, _ := json.Marshal(map[string]any{})
	req := httptest.NewRequest(http.MethodPost, path, bytes.NewReader(b))
	req.Header.Set("Content-Type", "application/json")
	return decodeResponse[projectHoldResumeConflict](t, h, req, http.StatusConflict)
}

func decodeResponse[T any](t *testing.T, h http.Handler, req *http.Request, ok ...int) T {
	t.Helper()
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if !statusOK(rr.Code, ok) {
		t.Fatalf("%s %s status=%d body=%s", req.Method, req.URL.Path, rr.Code, rr.Body.String())
	}
	var out T
	if err := json.Unmarshal(rr.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode response: %v body=%s", err, rr.Body.String())
	}
	return out
}

func statusOK(code int, allowed []int) bool {
	for _, value := range allowed {
		if code == value {
			return true
		}
	}
	return false
}

func multipartBody(t *testing.T, field, filename, contentType string, data []byte) (io.Reader, string) {
	t.Helper()
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	part, err := writer.CreatePart(textprotoMIMEHeader(field, filename, contentType))
	if err != nil {
		t.Fatalf("create multipart part: %v", err)
	}
	if _, err := part.Write(data); err != nil {
		t.Fatalf("write multipart part: %v", err)
	}
	if err := writer.Close(); err != nil {
		t.Fatalf("close multipart writer: %v", err)
	}
	return &body, writer.FormDataContentType()
}

func textprotoMIMEHeader(field, filename, contentType string) textproto.MIMEHeader {
	header := make(textproto.MIMEHeader)
	header.Set("Content-Disposition", `form-data; name="`+field+`"; filename="`+filename+`"`)
	header.Set("Content-Type", contentType)
	return header
}
