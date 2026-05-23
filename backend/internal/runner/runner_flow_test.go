package runner

import (
	"context"
	"testing"
	"time"

	"github.com/xiaobei/codex-issue-runner/backend/internal/codex"
	"github.com/xiaobei/codex-issue-runner/backend/internal/events"
	"github.com/xiaobei/codex-issue-runner/backend/internal/store"
)

func TestRunnerWaitsForExplicitIssueUpdateAfterClaiming(t *testing.T) {
	st := openRunnerStore(t)
	ctx := context.Background()
	_, _ = st.CreateProject(ctx, store.Project{ID: "demo", Name: "Demo", CWD: t.TempDir(), AutoRun: 1})
	issue, _ := st.CreateIssue(ctx, store.Issue{ProjectID: "demo", Title: "task", Status: store.StatusTodo})
	fake := &fakeCodex{events: make(chan codex.Event, 8), manualEvents: true}
	r := New(st, events.NewBus(), fake)

	if err := r.StartProject("demo"); err != nil {
		t.Fatalf("start project: %v", err)
	}
	defer r.StopProject("demo")

	claimed := waitIssueStatus(t, st, issue.ID, store.StatusInProgress)
	if claimed.AttemptCount != 1 {
		t.Fatalf("attempt count = %d, want 1", claimed.AttemptCount)
	}
	waitIssueRuntime(t, st, issue.ID, "thread-1", "turn-1")
	explicitlyCompleteIssue(t, st, issue.ID)
	fake.events <- codex.Event{Method: "turn/completed", ThreadID: "thread-1", TurnID: "turn-1", Status: "completed"}

	waitIssueNotRunning(t, r, issue.ID)
	got, _ := st.GetIssue(ctx, issue.ID)
	if got.Status != store.StatusDone || got.Error != "" {
		t.Fatalf("issue = %+v, want done without error", got)
	}
}

func explicitlyCompleteIssue(t *testing.T, st *store.Store, issueID int64) {
	t.Helper()
	_, err := st.SetIssueStatus(context.Background(), issueID, store.StatusDone, "")
	if err != nil {
		t.Fatalf("explicit issue update: %v", err)
	}
}

func waitIssueRuntime(t *testing.T, st *store.Store, id int64, threadID, turnID string) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		issue, _ := st.GetIssue(context.Background(), id)
		if issue.CodexThreadID == threadID && issue.CodexTurnID == turnID {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	issue, _ := st.GetIssue(context.Background(), id)
	t.Fatalf("runtime ids = %q/%q, want %q/%q", issue.CodexThreadID, issue.CodexTurnID, threadID, turnID)
}

func waitIssueNotRunning(t *testing.T, r *Runner, issueID int64) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		r.mu.Lock()
		_, ok := r.running[issueID]
		r.mu.Unlock()
		if !ok {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("issue %d still running", issueID)
}
