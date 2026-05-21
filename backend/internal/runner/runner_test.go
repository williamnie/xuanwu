package runner

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"github.com/xiaobei/codex-issue-runner/backend/internal/codex"
	"github.com/xiaobei/codex-issue-runner/backend/internal/events"
	"github.com/xiaobei/codex-issue-runner/backend/internal/store"
)

type fakeCodex struct {
	events chan codex.Event
}

func (f *fakeCodex) Start(context.Context) error { return nil }
func (f *fakeCodex) Stop(context.Context) error  { return nil }
func (f *fakeCodex) ThreadStart(context.Context, codex.ThreadInput) (string, error) {
	return "thread-1", nil
}
func (f *fakeCodex) ThreadList(context.Context, codex.SessionListInput) (codex.SessionListResult, error) {
	return codex.SessionListResult{}, nil
}
func (f *fakeCodex) ThreadRead(context.Context, string) (codex.Session, error) {
	return codex.Session{}, nil
}
func (f *fakeCodex) ThreadResume(context.Context, string) (codex.Session, error) {
	return codex.Session{}, nil
}
func (f *fakeCodex) TurnStart(context.Context, string, string) (string, error) {
	go func() {
		f.events <- codex.Event{Method: "item/agentMessage/delta", ThreadID: "thread-1", TurnID: "turn-1", Text: "working"}
		f.events <- codex.Event{Method: "turn/completed", ThreadID: "thread-1", TurnID: "turn-1", Status: "completed"}
	}()
	return "turn-1", nil
}
func (f *fakeCodex) InterruptTurn(context.Context, string, string) error { return nil }
func (f *fakeCodex) Events() <-chan codex.Event                          { return f.events }

func TestRunnerCompletesTodoIssue(t *testing.T) {
	st := openRunnerStore(t)
	ctx := context.Background()
	_, _ = st.CreateProject(ctx, store.Project{ID: "demo", Name: "Demo", CWD: t.TempDir(), AutoRun: 1})
	issue, _ := st.CreateIssue(ctx, store.Issue{ProjectID: "demo", Title: "task", Status: store.StatusTodo})
	r := New(st, events.NewBus(), &fakeCodex{events: make(chan codex.Event, 4)})
	if err := r.StartProject("demo"); err != nil {
		t.Fatalf("start project: %v", err)
	}
	defer r.StopProject("demo")
	got := waitIssueStatus(t, st, issue.ID, store.StatusDone)
	if got.CodexThreadID != "thread-1" || got.CodexTurnID != "turn-1" {
		t.Fatalf("runtime ids not persisted: %+v", got)
	}
	events, _ := st.ListIssueEvents(ctx, issue.ID)
	if len(events) == 0 {
		t.Fatalf("expected issue log/status events")
	}
}

func waitIssueStatus(t *testing.T, st *store.Store, id int64, want string) store.Issue {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		issue, _ := st.GetIssue(context.Background(), id)
		if issue.Status == want {
			return issue
		}
		time.Sleep(20 * time.Millisecond)
	}
	issue, _ := st.GetIssue(context.Background(), id)
	t.Fatalf("issue status = %s, want %s", issue.Status, want)
	return issue
}

func openRunnerStore(t *testing.T) *store.Store {
	t.Helper()
	st, err := store.Open(filepath.Join(t.TempDir(), "app.db"))
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })
	return st
}
