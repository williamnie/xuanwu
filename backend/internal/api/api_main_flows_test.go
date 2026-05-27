package api

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/xiaobei/codex-issue-runner/backend/internal/agent"
	"github.com/xiaobei/codex-issue-runner/backend/internal/runner"
	"github.com/xiaobei/codex-issue-runner/backend/internal/store"
)

func TestProjectAPIReadUpdateFlow(t *testing.T) {
	srv := newTestServer(t)
	created := postJSON[store.Project](t, srv, "/api/projects", map[string]any{
		"id": "demo", "name": "Demo", "cwd": t.TempDir(), "auto_run": 0,
	})
	if created.ID != "demo" {
		t.Fatalf("unexpected created project: %+v", created)
	}
	if created.Provider != store.ProviderCodex {
		t.Fatalf("project provider = %q, want codex", created.Provider)
	}
	if !hasCapability(created.ProviderCapabilities, string(agent.CapabilitySessions)) {
		t.Fatalf("created project capabilities = %+v, want sessions", created.ProviderCapabilities)
	}
	patched := patchJSON[store.Project](t, srv, "/api/projects/demo", map[string]any{
		"name": "Demo Renamed", "provider": "codex",
	})
	if patched.Name != "Demo Renamed" || patched.Provider != store.ProviderCodex {
		t.Fatalf("unexpected patched project: %+v", patched)
	}
	got := getJSON[store.Project](t, srv, "/api/projects/demo")
	if got.ID != "demo" || got.Name != "Demo Renamed" || got.Provider != store.ProviderCodex {
		t.Fatalf("unexpected fetched project: %+v", got)
	}
	if !hasCapability(got.ProviderCapabilities, string(agent.CapabilityModelList)) {
		t.Fatalf("fetched project capabilities = %+v, want model_list", got.ProviderCapabilities)
	}
}

func TestProjectAPIAcceptsClaudeIssueExecutionAutoRun(t *testing.T) {
	srv := newTestServer(t)
	srv.runner.RegisterProvider(executionOnlyAPIProvider{name: agent.ProviderClaudeCode})
	created := postJSON[store.Project](t, srv, "/api/projects", map[string]any{
		"id": "claude-demo", "cwd": t.TempDir(), "provider": agent.ProviderClaudeCode,
		"auto_run": 1,
	})
	defer srv.runner.StopProject(created.ID)

	if created.Provider != agent.ProviderClaudeCode || created.AutoRun != 1 ||
		created.LoopStatus != "running" {
		t.Fatalf("claude auto-run project should start: %+v", created)
	}
	if !hasCapability(created.ProviderCapabilities, string(agent.CapabilityIssueExecution)) ||
		hasCapability(created.ProviderCapabilities, string(agent.CapabilitySessions)) {
		t.Fatalf("claude capabilities should be issue_execution only: %+v", created.ProviderCapabilities)
	}
}

type executionOnlyAPIProvider struct {
	name string
}

func (p executionOnlyAPIProvider) Name() string { return p.name }

func (p executionOnlyAPIProvider) Start(context.Context) error { return nil }

func (p executionOnlyAPIProvider) RunIssue(
	context.Context,
	agent.IssueRunInput,
) (agent.IssueRunResult, error) {
	return agent.IssueRunResult{}, nil
}

func hasCapability(capabilities []string, want string) bool {
	for _, capability := range capabilities {
		if capability == want {
			return true
		}
	}
	return false
}

func TestIssueAPIListReadUpdateFlow(t *testing.T) {
	srv := newTestServer(t)
	postJSON[store.Project](t, srv, "/api/projects", map[string]any{
		"id": "demo", "cwd": t.TempDir(), "auto_run": 0,
	})
	issue := postJSON[store.Issue](t, srv, "/api/issues", map[string]any{
		"project_id": "demo", "description": "Fix bug from content", "status": "triage",
	})
	listed := getJSON[[]store.Issue](t, srv, "/api/issues?projectId=demo&status=triage")
	if len(listed) != 1 || listed[0].ID != issue.ID {
		t.Fatalf("unexpected filtered issues: %+v", listed)
	}
	got := getJSON[store.Issue](t, srv, "/api/issues/1")
	if got.ID != issue.ID || got.ProjectID != "demo" {
		t.Fatalf("unexpected fetched issue: %+v", got)
	}
	patched := patchJSON[store.Issue](t, srv, "/api/issues/1", map[string]any{
		"title": "Fix bug renamed",
	})
	if patched.Title != "Fix bug renamed" {
		t.Fatalf("unexpected patched issue: %+v", patched)
	}
}

func TestIssueRunsAPI(t *testing.T) {
	srv := newTestServer(t)
	ctx := t.Context()
	postJSON[store.Project](t, srv, "/api/projects", map[string]any{
		"id": "demo", "cwd": t.TempDir(), "auto_run": 0,
	})
	issue := postJSON[store.Issue](t, srv, "/api/issues", map[string]any{
		"project_id": "demo", "title": "run history", "status": "todo",
	})
	claimed, ok, err := srv.store.ClaimNextIssue(ctx, "demo")
	if err != nil || !ok {
		t.Fatalf("claim issue: ok=%v err=%v", ok, err)
	}
	if err := srv.store.UpdateIssueRuntime(ctx, claimed.ID, "thread-1", "turn-1"); err != nil {
		t.Fatalf("update runtime: %v", err)
	}
	if _, err := srv.store.SetIssueStatus(ctx, claimed.ID, store.StatusDone, ""); err != nil {
		t.Fatalf("mark done: %v", err)
	}

	runs := getJSON[[]store.IssueRun](t, srv, "/api/issues/1/runs")
	if len(runs) != 1 || runs[0].IssueID != issue.ID || runs[0].Status != store.StatusDone ||
		runs[0].Provider != store.ProviderCodex ||
		runs[0].ProviderSessionID != "thread-1" || runs[0].ProviderTurnID != "turn-1" ||
		runs[0].CodexThreadID != "thread-1" || runs[0].CodexTurnID != "turn-1" ||
		runs[0].StartedAt == "" || runs[0].EndedAt == "" {
		t.Fatalf("unexpected runs response: %+v", runs)
	}

	listed := getJSON[[]store.Issue](t, srv, "/api/issues?projectId=demo")
	if len(listed) != 1 || listed[0].LatestRun == nil || listed[0].LatestRun.ID != runs[0].ID ||
		listed[0].LatestRun.ProviderSessionID != "thread-1" || listed[0].LatestRun.ExitReason == "" {
		t.Fatalf("issue list should expose latest run summary: %+v", listed)
	}
}

func TestIssueStatusChangeFromInProgressInterruptsLinkedTurn(t *testing.T) {
	interrupts := make(chan [2]string, 1)
	srv := newTestServerWithCodex(t, interruptCaptureCodex{
		noopCodex:  noopCodex{ch: make(chan agent.Event)},
		interrupts: interrupts,
	})
	ctx := t.Context()
	postJSON[store.Project](t, srv, "/api/projects", map[string]any{
		"id": "demo", "cwd": t.TempDir(), "auto_run": 0,
	})
	postJSON[store.Issue](t, srv, "/api/issues", map[string]any{
		"project_id": "demo", "title": "running", "status": "todo",
	})
	claimed, ok, err := srv.store.ClaimNextIssue(ctx, "demo")
	if err != nil || !ok {
		t.Fatalf("claim issue: ok=%v err=%v", ok, err)
	}
	if err := srv.store.UpdateIssueRuntime(ctx, claimed.ID, "thread-active", "turn-active"); err != nil {
		t.Fatalf("update runtime: %v", err)
	}

	updated := patchJSON[store.Issue](t, srv, "/api/issues/1", map[string]any{
		"status": store.StatusTriage,
	})
	if updated.Status != store.StatusTriage {
		t.Fatalf("issue status = %q, want triage", updated.Status)
	}
	if got := readAPIInterrupt(t, interrupts); got != [2]string{"thread-active", "turn-active"} {
		t.Fatalf("interrupt = %v, want active provider turn", got)
	}
	runs := getJSON[[]store.IssueRun](t, srv, "/api/issues/1/runs")
	if len(runs) != 1 || runs[0].Status != store.StatusCancelled ||
		runs[0].ExitReason != "interrupted_by_status_change" || runs[0].EndedAt == "" {
		t.Fatalf("run should close as interrupted cancellation: %+v", runs)
	}
	assertAPIEvent(t, srv, 1, "issue.interrupt_requested")
	assertAPIEvent(t, srv, 1, "issue.interrupted")
	assertAPIEvent(t, srv, 1, "issue.status_changed")
}

func TestSessionInterruptLinkedIssueCancelsIssueRun(t *testing.T) {
	interrupts := make(chan [2]string, 1)
	srv := newTestServerWithCodex(t, interruptCaptureCodex{
		noopCodex:  noopCodex{ch: make(chan agent.Event)},
		interrupts: interrupts,
	})
	ctx := t.Context()
	postJSON[store.Project](t, srv, "/api/projects", map[string]any{
		"id": "demo", "cwd": t.TempDir(), "auto_run": 0,
	})
	postJSON[store.Issue](t, srv, "/api/issues", map[string]any{
		"project_id": "demo", "title": "running", "status": "todo",
	})
	claimed, ok, err := srv.store.ClaimNextIssue(ctx, "demo")
	if err != nil || !ok {
		t.Fatalf("claim issue: ok=%v err=%v", ok, err)
	}
	if err := srv.store.UpdateIssueRuntime(ctx, claimed.ID, "thread-linked", "turn-linked"); err != nil {
		t.Fatalf("update runtime: %v", err)
	}

	result := postJSON[runner.SessionInterruptResult](t, srv, "/api/sessions/codex:thread-linked/interrupt", map[string]any{})
	if !result.Interrupted {
		t.Fatalf("interrupt response = %+v, want interrupted", result)
	}
	if got := readAPIInterrupt(t, interrupts); got != [2]string{"thread-linked", "turn-linked"} {
		t.Fatalf("interrupt = %v, want linked issue turn", got)
	}
	issue := getJSON[store.Issue](t, srv, "/api/issues/1")
	if issue.Status != store.StatusCancelled {
		t.Fatalf("linked issue status = %q, want cancelled", issue.Status)
	}
	runs := getJSON[[]store.IssueRun](t, srv, "/api/issues/1/runs")
	if len(runs) != 1 || runs[0].Status != store.StatusCancelled ||
		runs[0].ExitReason != "session_interrupt" || runs[0].EndedAt == "" {
		t.Fatalf("linked issue run should close as session interrupt: %+v", runs)
	}
	assertAPIEvent(t, srv, 1, "issue.interrupt_requested")
	assertAPIEvent(t, srv, 1, "issue.interrupted")
	assertAPIEvent(t, srv, 1, "issue.status_changed")
	assertAPIEventReason(t, srv, 1, "issue.interrupted", "session_interrupt")
}

func TestSessionInterruptManualSessionDoesNotTouchIssue(t *testing.T) {
	interrupts := make(chan [2]string, 1)
	srv := newTestServerWithCodex(t, interruptCaptureCodex{
		noopCodex:  noopCodex{ch: make(chan agent.Event)},
		interrupts: interrupts,
	})
	postJSON[store.Project](t, srv, "/api/projects", map[string]any{
		"id": "demo", "cwd": t.TempDir(), "auto_run": 0,
	})
	postJSON[store.Issue](t, srv, "/api/issues", map[string]any{
		"project_id": "demo", "title": "backlog", "status": store.StatusTriage,
	})
	created := postJSON[runner.SessionCreateResult](t, srv, "/api/sessions", map[string]any{
		"cwd": t.TempDir(), "prompt": "hello",
	})

	result := postJSON[runner.SessionInterruptResult](t, srv, "/api/sessions/"+created.ID+"/interrupt", map[string]any{})
	if !result.Interrupted {
		t.Fatalf("interrupt response = %+v, want interrupted", result)
	}
	if got := readAPIInterrupt(t, interrupts); got != [2]string{"thread-new", "turn-new"} {
		t.Fatalf("manual session interrupt = %v, want thread-new/turn-new", got)
	}
	issue := getJSON[store.Issue](t, srv, "/api/issues/1")
	if issue.Status != store.StatusTriage {
		t.Fatalf("manual session interrupt must not touch issue: %+v", issue)
	}
	runs := getJSON[[]store.IssueRun](t, srv, "/api/issues/1/runs")
	if len(runs) != 0 {
		t.Fatalf("manual session interrupt must not create issue runs: %+v", runs)
	}
}

func TestIssueCancelInProgressInterruptsLinkedTurn(t *testing.T) {
	interrupts := make(chan [2]string, 1)
	srv := newTestServerWithCodex(t, interruptCaptureCodex{
		noopCodex:  noopCodex{ch: make(chan agent.Event)},
		interrupts: interrupts,
	})
	ctx := t.Context()
	postJSON[store.Project](t, srv, "/api/projects", map[string]any{
		"id": "demo", "cwd": t.TempDir(), "auto_run": 0,
	})
	postJSON[store.Issue](t, srv, "/api/issues", map[string]any{
		"project_id": "demo", "title": "running", "status": "todo",
	})
	claimed, ok, err := srv.store.ClaimNextIssue(ctx, "demo")
	if err != nil || !ok {
		t.Fatalf("claim issue: ok=%v err=%v", ok, err)
	}
	if err := srv.store.UpdateIssueRuntime(ctx, claimed.ID, "thread-cancel", "turn-cancel"); err != nil {
		t.Fatalf("update runtime: %v", err)
	}

	issue := postJSON[store.Issue](t, srv, "/api/issues/1/cancel", map[string]any{})
	if issue.Status != store.StatusCancelled {
		t.Fatalf("cancelled issue status = %q, want cancelled", issue.Status)
	}
	if got := readAPIInterrupt(t, interrupts); got != [2]string{"thread-cancel", "turn-cancel"} {
		t.Fatalf("interrupt = %v, want linked issue turn", got)
	}
	runs := getJSON[[]store.IssueRun](t, srv, "/api/issues/1/runs")
	if len(runs) != 1 || runs[0].Status != store.StatusCancelled ||
		runs[0].ExitReason != "issue_cancel" || runs[0].EndedAt == "" {
		t.Fatalf("cancelled issue run should close as issue_cancel: %+v", runs)
	}
	assertAPIEvent(t, srv, 1, "issue.interrupt_requested")
	assertAPIEvent(t, srv, 1, "issue.interrupted")
	assertAPIEvent(t, srv, 1, "issue.status_changed")
	assertAPIEventReason(t, srv, 1, "issue.interrupted", "issue_cancel")
}

func TestRecoveryIgnoresInterruptedStatusChangeRun(t *testing.T) {
	srv := newTestServerWithCodex(t, interruptCaptureCodex{
		noopCodex:  noopCodex{ch: make(chan agent.Event)},
		interrupts: make(chan [2]string, 1),
	})
	ctx := t.Context()
	postJSON[store.Project](t, srv, "/api/projects", map[string]any{
		"id": "demo", "cwd": t.TempDir(), "auto_run": 0,
	})
	postJSON[store.Issue](t, srv, "/api/issues", map[string]any{
		"project_id": "demo", "title": "running", "status": "todo",
	})
	claimed, ok, err := srv.store.ClaimNextIssue(ctx, "demo")
	if err != nil || !ok {
		t.Fatalf("claim issue: ok=%v err=%v", ok, err)
	}
	if err := srv.store.UpdateIssueRuntime(ctx, claimed.ID, "thread-active", "turn-active"); err != nil {
		t.Fatalf("update runtime: %v", err)
	}
	patchJSON[store.Issue](t, srv, "/api/issues/1", map[string]any{
		"status": store.StatusTriage,
	})

	if err := srv.runner.RecoverInProgressIssues(ctx); err != nil {
		t.Fatalf("recover in-progress issues: %v", err)
	}
	issue := getJSON[store.Issue](t, srv, "/api/issues/1")
	if issue.Status != store.StatusTriage {
		t.Fatalf("interrupted status-change issue should stay triage after recovery: %+v", issue)
	}
	runs := getJSON[[]store.IssueRun](t, srv, "/api/issues/1/runs")
	if len(runs) != 1 || runs[0].ExitReason != "interrupted_by_status_change" {
		t.Fatalf("interrupted run should remain traceable after recovery: %+v", runs)
	}
}

func TestRunnerCommandStatusIssueAndRunFlow(t *testing.T) {
	srv := newTestServer(t)
	postJSON[store.AgentProfile](t, srv, "/api/agent-profiles", map[string]any{
		"id": "nightly", "name": "Nightly Codex", "provider": "codex",
	})
	project := postJSON[store.Project](t, srv, "/api/projects", map[string]any{
		"id": "demo", "name": "Demo", "cwd": t.TempDir(), "auto_run": 0,
		"default_agent_profile_id": "nightly",
	})
	issue := postJSON[store.Issue](t, srv, "/api/issues", map[string]any{
		"project_id": project.ID, "title": "Command target", "description": "Do it", "status": store.StatusTriage,
	})

	status := postJSON[RunnerCommandResponse](t, srv, "/api/commands", map[string]any{
		"command": map[string]any{"name": "status", "args": map[string]any{"issue_id": issue.ID}},
	})
	if status.Command.Name != "status" || status.Issue == nil || status.Issue.ID != issue.ID || status.Project == nil ||
		status.Project.ID != project.ID || status.System.Runner.AutoRunProjects != 0 {
		t.Fatalf("unexpected status command response: %+v", status)
	}

	created := postJSON[RunnerCommandResponse](t, srv, "/api/commands", map[string]any{
		"command": map[string]any{
			"name": "issue",
			"args": map[string]any{"project_id": project.ID, "prompt": "新的 triage 草稿\n\n验收", "references": []map[string]any{{"type": "issue", "id": strconv.FormatInt(issue.ID, 10)}}},
		},
	})
	if created.Issue == nil || created.Issue.Status != store.StatusTriage || created.Issue.ProjectID != project.ID ||
		!strings.Contains(created.Issue.Description, "新的 triage 草稿") || !strings.Contains(created.Summary, "created") {
		t.Fatalf("unexpected issue command response: %+v", created)
	}

	run := postJSON[RunnerCommandResponse](t, srv, "/api/commands", map[string]any{
		"command": map[string]any{"name": "run", "args": map[string]any{"issue_id": created.Issue.ID, "confirmed": true}},
	})
	if run.Issue == nil || run.Issue.Status != store.StatusTodo {
		t.Fatalf("run command should enqueue issue: %+v", run)
	}
	if run.RunSelection == nil || run.RunSelection.ProfileID != "nightly" ||
		run.RunSelection.ProviderID != store.ProviderCodex ||
		run.RunSelection.SelectionReason != "project_default" {
		t.Fatalf("run command should return dispatcher metadata: %+v", run.RunSelection)
	}
}

func TestRunnerCommandRunRejectsUnavailableProfileProvider(t *testing.T) {
	srv := newTestServer(t)
	postJSON[store.AgentProfile](t, srv, "/api/agent-profiles", map[string]any{
		"id": "fake", "name": "Fake", "provider": agent.ProviderFakeExecutionOnly,
	})
	postJSON[store.Project](t, srv, "/api/projects", map[string]any{
		"id": "demo", "cwd": t.TempDir(), "auto_run": 0,
		"default_agent_profile_id": "fake",
	})
	issue := postJSON[store.Issue](t, srv, "/api/issues", map[string]any{
		"project_id": "demo", "title": "Needs fake provider", "status": store.StatusTriage,
	})

	body := postRunnerCommandFailure(t, srv, map[string]any{
		"command": map[string]any{"name": "run", "args": map[string]any{"issue_id": issue.ID, "confirmed": true}},
	})
	if !strings.Contains(body, agent.ProviderFakeExecutionOnly) || !strings.Contains(body, "当前 runner 未注册") {
		t.Fatalf("run command should expose dispatcher provider error: %s", body)
	}
	unchanged := getJSON[store.Issue](t, srv, "/api/issues/1")
	if unchanged.Status != store.StatusTriage {
		t.Fatalf("dispatcher preflight must not enqueue issue: %+v", unchanged)
	}
}

func TestRunnerCommandRunRejectsDirtyWorktree(t *testing.T) {
	repo := initAPIGitRepo(t)
	if err := os.WriteFile(filepath.Join(repo, "scratch.txt"), []byte("dirty"), 0o600); err != nil {
		t.Fatalf("write dirty file: %v", err)
	}
	srv := newTestServer(t)
	postJSON[store.Project](t, srv, "/api/projects", map[string]any{
		"id": "demo", "cwd": repo, "auto_run": 0,
	})
	issue := postJSON[store.Issue](t, srv, "/api/issues", map[string]any{
		"project_id": "demo", "title": "Dirty safe", "status": store.StatusTriage,
	})

	body := postRunnerCommandFailure(t, srv, map[string]any{
		"command": map[string]any{"name": "run", "args": map[string]any{"issue_id": issue.ID, "confirmed": true}},
	})
	if !strings.Contains(body, "未提交修改") || !strings.Contains(body, "scratch.txt") {
		t.Fatalf("dirty run command should expose preflight error: %s", body)
	}
	unchanged := getJSON[store.Issue](t, srv, "/api/issues/1")
	if unchanged.Status != store.StatusTriage {
		t.Fatalf("dirty preflight must not enqueue issue: %+v", unchanged)
	}
}

func TestRunnerCommandRunRequiresConfirmation(t *testing.T) {
	srv := newTestServer(t)
	postJSON[store.Project](t, srv, "/api/projects", map[string]any{
		"id": "demo", "cwd": t.TempDir(), "auto_run": 0,
	})
	issue := postJSON[store.Issue](t, srv, "/api/issues", map[string]any{
		"project_id": "demo", "title": "Safe run", "status": store.StatusTriage,
	})

	body := postRunnerCommandFailure(t, srv, map[string]any{
		"command": map[string]any{"name": "run", "args": map[string]any{"issue_id": issue.ID}},
	})
	if !strings.Contains(body, "需要确认") {
		t.Fatalf("run without confirmation should explain confirmation requirement: %s", body)
	}
	unchanged := getJSON[store.Issue](t, srv, "/api/issues/1")
	if unchanged.Status != store.StatusTriage {
		t.Fatalf("cancelled/unconfirmed run must not mutate issue: %+v", unchanged)
	}
}

func TestSessionAPIReadAndMessageFlow(t *testing.T) {
	srv := newTestServerWithCodex(t, noopCodex{ch: make(chan agent.Event)})
	session := getJSON[agent.Session](t, srv, "/api/sessions/codex:thread-1")
	if session.ID != "codex:thread-1" || session.Provider != store.ProviderCodex ||
		session.ProviderSessionID != "thread-1" || session.CWD != "/tmp/demo" {
		t.Fatalf("unexpected session detail: %+v", session)
	}
	created := postJSON[runner.SessionCreateResult](t, srv, "/api/sessions", map[string]any{
		"cwd": t.TempDir(), "prompt": "hello",
	})
	if created.ID != "codex:thread-new" || created.Provider != store.ProviderCodex ||
		created.ProviderSessionID != "thread-new" || created.ProviderTurnID != "turn-new" ||
		created.ThreadID != "thread-new" || created.TurnID != "turn-new" {
		t.Fatalf("unexpected created session: %+v", created)
	}
	message := postJSON[map[string]string](t, srv, "/api/sessions/codex:thread-1/messages", map[string]any{
		"prompt": "continue",
	})
	if message["thread_id"] != "thread-1" || message["turn_id"] != "turn-new" {
		t.Fatalf("unexpected session message: %+v", message)
	}
}

func TestSessionAPIReferencesFlow(t *testing.T) {
	projectRoot := t.TempDir()
	if err := os.WriteFile(filepath.Join(projectRoot, "notes.md"), []byte("context"), 0o644); err != nil {
		t.Fatalf("write file: %v", err)
	}
	provider := &sessionReferenceAPICodex{
		noopCodex: noopCodex{ch: make(chan agent.Event)},
		cwd:       projectRoot,
	}
	srv := newTestServerWithCodex(t, provider)
	project := postJSON[store.Project](t, srv, "/api/projects", map[string]any{
		"id": "demo", "cwd": projectRoot, "auto_run": 0,
	})
	issue := postJSON[store.Issue](t, srv, "/api/issues", map[string]any{
		"project_id": project.ID, "title": "API refs", "description": "Issue description must be injected", "status": store.StatusTodo,
	})
	claimed, ok, err := srv.store.ClaimNextIssue(context.Background(), project.ID)
	if err != nil || !ok {
		t.Fatalf("claim issue for latest run: ok=%v err=%v", ok, err)
	}
	if err := srv.store.UpdateIssueRuntime(context.Background(), claimed.ID, "thread-ref", "turn-ref"); err != nil {
		t.Fatalf("update issue runtime: %v", err)
	}
	if _, err := srv.store.UpdateIssue(context.Background(), claimed.ID, store.IssuePatch{Status: ptr(store.StatusFailed), Error: ptr("latest run failure")}); err != nil {
		t.Fatalf("close issue run: %v", err)
	}
	issueID := strconv.FormatInt(issue.ID, 10)

	created := postJSON[runner.SessionCreateResult](t, srv, "/api/sessions", map[string]any{
		"project_id": project.ID,
		"prompt":     "继续处理",
		"references": []map[string]any{
			{"type": "issue", "id": issueID},
			{"type": "file", "path": "notes.md"},
		},
	})
	createPrompt := apiUserInputText(provider.turnInput)
	for _, want := range []string{"API refs", "Issue description must be injected", "latest run: failed", "latest run failure", "file notes.md", "context"} {
		if created.TurnID == "" || !strings.Contains(createPrompt, want) {
			t.Fatalf("create references missing %q: result=%+v prompt=%s", want, created, createPrompt)
		}
	}
	records, err := srv.store.ListSessionTurnReferences(context.Background(), created.ProviderSessionID, created.ProviderTurnID)
	if err != nil || len(records) != 1 {
		t.Fatalf("create references metadata = %+v err=%v", records, err)
	}

	provider.turnInput = nil
	message := postJSON[map[string]string](t, srv, "/api/sessions/codex:thread-1/messages", map[string]any{
		"prompt": "继续消息",
		"references": []map[string]any{
			{"type": "issue", "id": issueID},
			{"type": "file", "path": "notes.md"},
		},
	})
	if message["turn_id"] == "" || !strings.Contains(apiUserInputText(provider.turnInput), "file notes.md") {
		t.Fatalf("message references not passed to Codex: result=%+v prompt=%s", message, apiUserInputText(provider.turnInput))
	}
}

type sessionReferenceAPICodex struct {
	noopCodex
	cwd       string
	turnInput []agent.UserInput
}

func (c *sessionReferenceAPICodex) ResumeThread(context.Context, string) (agent.Session, error) {
	return agent.Session{ID: "thread-1", CWD: c.cwd}, nil
}

func (c *sessionReferenceAPICodex) StartTurn(_ context.Context, _ string, input []agent.UserInput, _ agent.TurnOptions) (string, error) {
	c.turnInput = input
	return "turn-new", nil
}

type interruptCaptureCodex struct {
	noopCodex
	interrupts chan [2]string
}

func (c interruptCaptureCodex) InterruptTurn(_ context.Context, threadID, turnID string) error {
	if c.interrupts != nil {
		c.interrupts <- [2]string{threadID, turnID}
	}
	return nil
}

func readAPIInterrupt(t *testing.T, interrupts <-chan [2]string) [2]string {
	t.Helper()
	select {
	case got := <-interrupts:
		return got
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for provider interrupt")
		return [2]string{}
	}
}

func assertAPIEvent(t *testing.T, srv *Server, issueID int64, typ string) {
	t.Helper()
	events := getJSON[[]store.IssueEvent](t, srv, "/api/issues/1/events")
	for _, event := range events {
		if event.IssueID == issueID && event.Type == typ {
			return
		}
	}
	t.Fatalf("missing event %s: %+v", typ, events)
}

func assertAPIEventReason(t *testing.T, srv *Server, issueID int64, typ, reason string) {
	t.Helper()
	events := getJSON[[]store.IssueEvent](t, srv, "/api/issues/1/events")
	for _, event := range events {
		if event.IssueID != issueID || event.Type != typ {
			continue
		}
		var payload map[string]string
		if err := json.Unmarshal([]byte(event.Payload), &payload); err != nil {
			t.Fatalf("decode event payload: %v payload=%q", err, event.Payload)
		}
		if payload["reason"] == reason {
			return
		}
		t.Fatalf("event %s reason = %q, want %q: %+v", typ, payload["reason"], reason, events)
	}
	t.Fatalf("missing event %s: %+v", typ, events)
}

func TestRunnerCommandPersistsSessionHistoryAndSourceMetadata(t *testing.T) {
	srv := newTestServerWithCodex(t, sessionDetailCodex{
		noopCodex: noopCodex{ch: make(chan agent.Event)},
	})
	project := postJSON[store.Project](t, srv, "/api/projects", map[string]any{
		"id": "demo", "name": "Demo", "cwd": t.TempDir(), "auto_run": 0,
	})
	seed := postJSON[store.Issue](t, srv, "/api/issues", map[string]any{
		"project_id": project.ID, "title": "Existing target", "description": "Check status", "status": store.StatusTriage,
	})

	_ = postJSON[RunnerCommandResponse](t, srv, "/api/commands", map[string]any{
		"session_id": "codex:thread-1",
		"prompt":     "请查询 token=secret-value 是否会泄露",
		"references": []map[string]any{{"type": "issue", "id": strconv.FormatInt(seed.ID, 10), "label": "Existing target"}},
		"command":    map[string]any{"name": "status", "args": map[string]any{"issue_id": seed.ID, "api_token": "secret-value"}},
	})
	created := postJSON[RunnerCommandResponse](t, srv, "/api/commands", map[string]any{
		"session_id": "codex:thread-1",
		"prompt":     "从 composer 创建可追溯 issue",
		"command":    map[string]any{"name": "issue", "args": map[string]any{"project_id": project.ID}},
	})
	if created.Issue == nil || created.Issue.SourceSessionID != "thread-1" ||
		!strings.Contains(created.Issue.SourceExcerpt, "Composer /issue") {
		t.Fatalf("created issue should keep command source metadata: %+v", created.Issue)
	}
	_ = postJSON[RunnerCommandResponse](t, srv, "/api/commands", map[string]any{
		"session_id": "codex:thread-1",
		"command":    map[string]any{"name": "run", "args": map[string]any{"issue_id": created.Issue.ID, "confirmed": true}},
	})
	_ = postRunnerCommandFailure(t, srv, map[string]any{
		"session_id": "codex:thread-1",
		"command":    map[string]any{"name": "run", "args": map[string]any{"issue_id": created.Issue.ID}},
	})

	detail := getJSON[sessionDetailResponse](t, srv, "/api/sessions/codex:thread-1")
	if len(detail.CommandHistory) != 4 {
		t.Fatalf("command history should persist across session detail reads: %+v", detail.CommandHistory)
	}
	if detail.CommandHistory[0].CommandName != "status" || detail.CommandHistory[0].TargetIssueID != seed.ID ||
		!strings.Contains(detail.CommandHistory[0].ResultSummary, "issue #1 is triage") ||
		strings.Contains(detail.CommandHistory[0].PromptSummary, "secret-value") ||
		strings.Contains(detail.CommandHistory[0].CommandArgsJSON, "secret-value") ||
		!strings.Contains(detail.CommandHistory[0].CommandArgsJSON, "[redacted]") {
		t.Fatalf("unexpected status history: %+v", detail.CommandHistory[0])
	}
	if detail.CommandHistory[1].CommandName != "issue" || detail.CommandHistory[1].CreatedIssueID != created.Issue.ID {
		t.Fatalf("unexpected issue history: %+v", detail.CommandHistory[1])
	}
	if detail.CommandHistory[2].CommandName != "run" || detail.CommandHistory[2].EnqueuedIssueID != created.Issue.ID ||
		!strings.Contains(detail.CommandHistory[2].ResultSummary, "enqueued issue") {
		t.Fatalf("unexpected run history: %+v", detail.CommandHistory[2])
	}
	if detail.CommandHistory[3].Error == "" || strings.Contains(strings.ToLower(detail.CommandHistory[3].Error), "secret-value") {
		t.Fatalf("failure history should keep a safe error summary: %+v", detail.CommandHistory[3])
	}
}

func TestRunnerCommandWithoutSessionDoesNotCreateSessionHistory(t *testing.T) {
	srv := newTestServerWithCodex(t, sessionDetailCodex{
		noopCodex: noopCodex{ch: make(chan agent.Event)},
	})
	postJSON[store.Project](t, srv, "/api/projects", map[string]any{
		"id": "demo", "cwd": t.TempDir(), "auto_run": 0,
	})
	postJSON[store.Issue](t, srv, "/api/issues", map[string]any{
		"project_id": "demo", "title": "Target", "status": store.StatusTriage,
	})
	_ = postJSON[RunnerCommandResponse](t, srv, "/api/commands", map[string]any{
		"command": map[string]any{"name": "status", "args": map[string]any{"issue_id": 1}},
	})

	detail := getJSON[sessionDetailResponse](t, srv, "/api/sessions/codex:thread-1")
	if len(detail.CommandHistory) != 0 {
		t.Fatalf("unscoped command should not fake session history: %+v", detail.CommandHistory)
	}
}
