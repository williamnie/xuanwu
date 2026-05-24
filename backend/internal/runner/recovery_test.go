package runner

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/xiaobei/codex-issue-runner/backend/internal/agent"
	"github.com/xiaobei/codex-issue-runner/backend/internal/events"
	"github.com/xiaobei/codex-issue-runner/backend/internal/store"
)

func TestRecoverInProgressIssuesAttachesToActiveTurn(t *testing.T) {
	st := openRunnerStore(t)
	ctx := context.Background()
	issue := createRecoverableIssue(t, st, "recover", "thread-live", "turn-live")
	fake := &fakeCodex{
		events: make(chan agent.Event, 8),
		resumeSession: agent.Session{
			ID:     "thread-live",
			Status: json.RawMessage(`{"type":"active","activeFlags":[]}`),
			Turns:  json.RawMessage(`[{"id":"turn-live","status":"inProgress"}]`),
		},
	}
	r := New(st, events.NewBus(), fake)

	if err := r.RecoverInProgressIssues(ctx); err != nil {
		t.Fatalf("recover in-progress issues: %v", err)
	}
	waitForResumeCall(t, fake, 1)
	if len(fake.turnInputs) != 0 {
		t.Fatalf("active turn should not start a new turn: %+v", fake.turnInputs)
	}
	got, _ := st.GetIssue(ctx, issue.ID)
	if got.Status != store.StatusInProgress || got.Error != "" {
		t.Fatalf("active recovery should keep issue in progress: %+v", got)
	}
	assertIssueEvent(t, st, issue.ID, "issue.recovery_started")
	assertIssueEvent(t, st, issue.ID, "issue.recovery_attached")
	r.CancelIssue(issue.ID)
	waitIssueNotRunning(t, r, issue.ID)
}

func TestRecoverInProgressIssuesStartsContinueTurnWhenThreadIdle(t *testing.T) {
	st := openRunnerStore(t)
	ctx := context.Background()
	issue := createRecoverableIssue(t, st, "recover idle", "thread-idle", "turn-done")
	fake := &fakeCodex{
		events: make(chan agent.Event, 8),
		resumeSession: agent.Session{
			ID:     "thread-idle",
			Status: json.RawMessage(`{"type":"idle"}`),
			Turns:  json.RawMessage(`[{"id":"turn-done","status":"completed"}]`),
		},
		manualEvents: true,
	}
	r := New(st, events.NewBus(), fake)

	if err := r.RecoverInProgressIssues(ctx); err != nil {
		t.Fatalf("recover in-progress issues: %v", err)
	}
	waitForResumeCall(t, fake, 1)
	if len(fake.turnInputs) != 1 {
		t.Fatalf("idle thread should start a continuation turn: %+v", fake.turnInputs)
	}
	assertRecoveryPrompt(t, stringFromUserInputs(fake.turnInputs), issue.ID)
	assertIssueEvent(t, st, issue.ID, "issue.recovery_turn_started")
	r.CancelIssue(issue.ID)
	waitIssueNotRunning(t, r, issue.ID)
}

func TestRecoverInProgressIssuesFailsWithoutThreadID(t *testing.T) {
	st := openRunnerStore(t)
	ctx := context.Background()
	_, _ = st.CreateProject(ctx, store.Project{ID: "demo", Name: "Demo", CWD: t.TempDir()})
	issue, _ := st.CreateIssue(ctx, store.Issue{ProjectID: "demo", Title: "broken", Status: store.StatusInProgress})
	fake := &fakeCodex{events: make(chan agent.Event, 8)}
	r := New(st, events.NewBus(), fake)

	if err := r.RecoverInProgressIssues(ctx); err != nil {
		t.Fatalf("recover in-progress issues: %v", err)
	}
	got, err := st.GetIssue(ctx, issue.ID)
	if err != nil {
		t.Fatalf("get issue: %v", err)
	}
	if got.Status != store.StatusFailed || got.Error == "" {
		t.Fatalf("missing thread id should fail issue: %+v", got)
	}
	assertIssueEvent(t, st, issue.ID, "issue.recovery_failed")
}

func TestRecoveryTurnRequiresExplicitIssueStatusUpdate(t *testing.T) {
	st := openRunnerStore(t)
	ctx := context.Background()
	issue := createRecoverableIssue(t, st, "recover missing status", "thread-idle", "turn-done")
	fake := &fakeCodex{
		events: make(chan agent.Event, 8),
		resumeSession: agent.Session{
			ID:     "thread-idle",
			Status: json.RawMessage(`{"type":"idle"}`),
			Turns:  json.RawMessage(`[{"id":"turn-done","status":"completed"}]`),
		},
		manualEvents: true,
	}
	r := New(st, events.NewBus(), fake)

	if err := r.RecoverInProgressIssues(ctx); err != nil {
		t.Fatalf("recover in-progress issues: %v", err)
	}
	waitIssueRuntime(t, st, issue.ID, "thread-idle", "turn-1")
	fake.events <- agent.Event{Method: "turn/completed", ThreadID: "thread-idle", TurnID: "turn-1", Status: "completed"}

	got := waitIssueStatus(t, st, issue.ID, store.StatusFailed)
	if !strings.Contains(got.Error, "explicit issue status update") {
		t.Fatalf("error = %q, want missing explicit status guard", got.Error)
	}
}

func TestCancelRecoveryInterruptsRecoveredTurn(t *testing.T) {
	st := openRunnerStore(t)
	ctx := context.Background()
	issue := createRecoverableIssue(t, st, "recover cancel", "thread-live", "turn-live")
	interrupts := make(chan [2]string, 1)
	fake := &fakeCodex{
		events:     make(chan agent.Event, 8),
		interrupts: interrupts,
		resumeSession: agent.Session{
			ID:     "thread-live",
			Status: json.RawMessage(`{"type":"active"}`),
			Turns:  json.RawMessage(`[{"id":"turn-live","status":"inProgress"}]`),
		},
	}
	r := New(st, events.NewBus(), fake)

	if err := r.RecoverInProgressIssues(ctx); err != nil {
		t.Fatalf("recover in-progress issues: %v", err)
	}
	waitForResumeCall(t, fake, 1)
	r.CancelIssue(issue.ID)

	got := waitInterrupt(t, interrupts)
	if got != [2]string{"thread-live", "turn-live"} {
		t.Fatalf("interrupt = %v, want thread-live/turn-live", got)
	}
	waitIssueNotRunning(t, r, issue.ID)
}

func createRecoverableIssue(t *testing.T, st *store.Store, title, threadID, turnID string) store.Issue {
	t.Helper()
	ctx := context.Background()
	_, _ = st.CreateProject(ctx, store.Project{ID: "demo", Name: "Demo", CWD: t.TempDir()})
	created, _ := st.CreateIssue(ctx, store.Issue{ProjectID: "demo", Title: title, Status: store.StatusTodo})
	claimed, ok, err := st.ClaimNextIssue(ctx, "demo")
	if err != nil || !ok {
		t.Fatalf("claim issue: ok=%v err=%v", ok, err)
	}
	if claimed.ID != created.ID {
		t.Fatalf("claimed issue = %d, want %d", claimed.ID, created.ID)
	}
	if err := st.UpdateIssueRuntime(ctx, claimed.ID, threadID, turnID); err != nil {
		t.Fatalf("update runtime: %v", err)
	}
	return claimed
}

func assertRecoveryPrompt(t *testing.T, got string, issueID int64) {
	t.Helper()
	needles := []string{
		"服务重启后继续处理 issue #",
		"项目路径：",
		"git status",
		"git diff",
		"codex-issue-runner issue status --id",
		"codex-issue-runner issue logs --id",
		"避免重复已完成操作",
		"codex-issue-runner issue update",
	}
	for _, needle := range needles {
		if !strings.Contains(got, needle) {
			t.Fatalf("recovery prompt missing %q for issue %d:\n%s", needle, issueID, got)
		}
	}
}

func assertIssueEvent(t *testing.T, st *store.Store, issueID int64, typ string) {
	t.Helper()
	events, err := st.ListIssueEvents(context.Background(), issueID)
	if err != nil {
		t.Fatalf("list events: %v", err)
	}
	for _, event := range events {
		if event.Type == typ {
			return
		}
	}
	t.Fatalf("missing %s event: %+v", typ, events)
}

func waitForResumeCall(t *testing.T, fake *fakeCodex, want int) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if fake.resumeCalls >= want {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("resume calls = %d, want >= %d", fake.resumeCalls, want)
}

func waitInterrupt(t *testing.T, interrupts <-chan [2]string) [2]string {
	t.Helper()
	select {
	case got := <-interrupts:
		return got
	case <-time.After(2 * time.Second):
		t.Fatalf("missing interrupt")
		return [2]string{}
	}
}

func stringFromUserInputs(inputs []agent.UserInput) string {
	var b strings.Builder
	for _, input := range inputs {
		if input.Type == "text" {
			b.WriteString(input.Text)
		}
	}
	return b.String()
}
