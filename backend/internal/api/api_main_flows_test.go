package api

import (
	"context"
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
