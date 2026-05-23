package runner

import (
	"context"
	"errors"
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

func TestRunnerHoldsProjectAndStopsClaimingOnUsageLimit(t *testing.T) {
	st := openRunnerStore(t)
	ctx := context.Background()
	_, _ = st.CreateProject(ctx, store.Project{ID: "demo", Name: "Demo", CWD: t.TempDir(), AutoRun: 1})
	first, _ := st.CreateIssue(ctx, store.Issue{ProjectID: "demo", Title: "limited", Status: store.StatusTodo, Priority: 2})
	second, _ := st.CreateIssue(ctx, store.Issue{ProjectID: "demo", Title: "must wait", Status: store.StatusTodo})
	fake := &fakeCodex{events: make(chan codex.Event, 8), manualEvents: true}
	r := New(st, events.NewBus(), fake)

	if err := r.StartProject("demo"); err != nil {
		t.Fatalf("start project: %v", err)
	}
	defer r.StopProject("demo")
	waitIssueRuntime(t, st, first.ID, "thread-1", "turn-1")
	fake.events <- codex.Event{
		Method: "error", ThreadID: "thread-1", TurnID: "turn-1",
		Error: `API returned 429: {"error":{"type":"usage_limit_reached","message":"The usage limit has been reached","resets_in_seconds":3600}}`,
	}

	got := waitIssueStatus(t, st, first.ID, store.StatusTodo)
	if got.AttemptCount != 1 || got.Error == "" {
		t.Fatalf("held issue should be todo with one claim and reason: %+v", got)
	}
	project := waitProjectHold(t, st, "demo")
	if project.Hold.Reason != HoldReasonUsageLimit {
		t.Fatalf("project hold = %+v", project.Hold)
	}
	unchanged, _ := st.GetIssue(ctx, second.ID)
	if unchanged.Status != store.StatusTodo || unchanged.AttemptCount != 0 {
		t.Fatalf("second issue should remain unclaimed: %+v", unchanged)
	}
}

func TestRunnerHoldsProjectWhenTurnStartReturnsAuthError(t *testing.T) {
	st := openRunnerStore(t)
	ctx := context.Background()
	_, _ = st.CreateProject(ctx, store.Project{ID: "demo", Name: "Demo", CWD: t.TempDir(), AutoRun: 1})
	issue, _ := st.CreateIssue(ctx, store.Issue{ProjectID: "demo", Title: "auth", Status: store.StatusTodo})
	fake := &fakeCodex{
		events:       make(chan codex.Event, 8),
		manualEvents: true,
		turnErr:      errors.New("API returned 401: invalid bearer token"),
	}
	r := New(st, events.NewBus(), fake)

	if err := r.StartProject("demo"); err != nil {
		t.Fatalf("start project: %v", err)
	}
	defer r.StopProject("demo")

	got := waitIssueError(t, st, issue.ID)
	if got.AttemptCount != 1 || got.Error == "" {
		t.Fatalf("held issue should return to todo with reason: %+v", got)
	}
	project := waitProjectHold(t, st, "demo")
	if project.Hold.Reason != HoldReasonAuthentication {
		t.Fatalf("project hold = %+v", project.Hold)
	}
}

func TestRunnerHealthCheckClearsHoldAndResumesQueue(t *testing.T) {
	st := openRunnerStore(t)
	ctx := context.Background()
	_, _ = st.CreateProject(ctx, store.Project{ID: "demo", Name: "Demo", CWD: t.TempDir(), AutoRun: 1})
	issue, _ := st.CreateIssue(ctx, store.Issue{ProjectID: "demo", Title: "resume", Status: store.StatusTodo})
	_, _ = st.SetProjectHold(ctx, "demo", store.ProjectHold{
		Reason:  HoldReasonAuthentication,
		Message: "Runner paused: authentication failed",
	})
	fake := &fakeCodex{events: make(chan codex.Event, 8), manualEvents: true}
	r := New(st, events.NewBus(), fake)

	fake.startErr = errors.New("API returned 401: expired token")
	if err := r.CheckHeldProjects(ctx); err != nil {
		t.Fatalf("health check should record failed project checks and continue: %v", err)
	}
	stillHeld, _ := st.GetProject(ctx, "demo")
	if stillHeld.Hold == nil || stillHeld.Hold.LastCheckError == "" {
		t.Fatalf("failed check should keep hold with error: %+v", stillHeld)
	}

	fake.startErr = nil
	r.healthCheckWait = 20 * time.Millisecond
	fake.autoTurns = 1
	if err := r.CheckHeldProjects(ctx); err != nil {
		t.Fatalf("health check success: %v", err)
	}
	cleared, _ := st.GetProject(ctx, "demo")
	if cleared.Hold != nil {
		t.Fatalf("hold should clear after healthy check: %+v", cleared)
	}
	claimed := waitIssueStatus(t, st, issue.ID, store.StatusInProgress)
	if claimed.AttemptCount != 1 {
		t.Fatalf("runner should resume and claim issue once: %+v", claimed)
	}
}

func explicitlyCompleteIssue(t *testing.T, st *store.Store, issueID int64) {
	t.Helper()
	_, err := st.SetIssueStatus(context.Background(), issueID, store.StatusDone, "")
	if err != nil {
		t.Fatalf("explicit issue update: %v", err)
	}
}

func waitProjectHold(t *testing.T, st *store.Store, projectID string) store.Project {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		project, _ := st.GetProject(context.Background(), projectID)
		if project.Hold != nil {
			return project
		}
		time.Sleep(20 * time.Millisecond)
	}
	project, _ := st.GetProject(context.Background(), projectID)
	t.Fatalf("project hold missing: %+v", project)
	return project
}

func waitIssueError(t *testing.T, st *store.Store, id int64) store.Issue {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		issue, _ := st.GetIssue(context.Background(), id)
		if issue.Status == store.StatusTodo && issue.Error != "" {
			return issue
		}
		time.Sleep(20 * time.Millisecond)
	}
	issue, _ := st.GetIssue(context.Background(), id)
	t.Fatalf("issue error missing after hold: %+v", issue)
	return issue
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
