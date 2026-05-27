package runner

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/xiaobei/codex-issue-runner/backend/internal/agent"
	"github.com/xiaobei/codex-issue-runner/backend/internal/events"
	"github.com/xiaobei/codex-issue-runner/backend/internal/store"
)

func TestRunnerWaitsForExplicitIssueUpdateAfterClaiming(t *testing.T) {
	st := openRunnerStore(t)
	ctx := context.Background()
	_, _ = st.CreateProject(ctx, store.Project{ID: "demo", Name: "Demo", CWD: t.TempDir(), AutoRun: 1})
	issue, _ := st.CreateIssue(ctx, store.Issue{ProjectID: "demo", Title: "task", Status: store.StatusTodo})
	fake := &fakeCodex{events: make(chan agent.Event, 8), manualEvents: true}
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
	fake.events <- agent.Event{Method: "turn/completed", ThreadID: "thread-1", TurnID: "turn-1", Status: "completed"}

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
	fake := &fakeCodex{events: make(chan agent.Event, 8), manualEvents: true}
	r := New(st, events.NewBus(), fake)

	if err := r.StartProject("demo"); err != nil {
		t.Fatalf("start project: %v", err)
	}
	defer r.StopProject("demo")
	waitIssueRuntime(t, st, first.ID, "thread-1", "turn-1")
	fake.events <- agent.Event{
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
		events:       make(chan agent.Event, 8),
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

func TestRunnerRetriesExistingIssueInSameThread(t *testing.T) {
	st := openRunnerStore(t)
	ctx := context.Background()
	_, _ = st.CreateProject(ctx, store.Project{ID: "demo", Name: "Demo", CWD: t.TempDir(), AutoRun: 1})
	issue, _ := st.CreateIssue(ctx, store.Issue{ProjectID: "demo", Title: "manual retry", Status: store.StatusTodo})
	if _, ok, err := st.ClaimNextIssue(ctx, "demo"); err != nil || !ok {
		t.Fatalf("claim issue: ok=%v err=%v", ok, err)
	}
	if err := st.UpdateIssueRuntime(ctx, issue.ID, "thread-retry", "turn-old"); err != nil {
		t.Fatalf("seed runtime: %v", err)
	}
	if _, err := st.SetIssueStatus(ctx, issue.ID, store.StatusFailed, "failed once"); err != nil {
		t.Fatalf("fail seed issue: %v", err)
	}
	empty := ""
	todo := store.StatusTodo
	if _, err := st.UpdateIssue(ctx, issue.ID, store.IssuePatch{
		Status: &todo, Error: &empty, CodexTurnID: &empty,
	}); err != nil {
		t.Fatalf("queue retry: %v", err)
	}
	fake := &fakeCodex{events: make(chan agent.Event, 8), manualEvents: true}
	r := New(st, events.NewBus(), fake)

	if err := r.StartProject("demo"); err != nil {
		t.Fatalf("start project: %v", err)
	}
	defer r.StopProject("demo")

	waitIssueRuntime(t, st, issue.ID, "thread-retry", "turn-1")
	if len(fake.threadInputs) != 0 {
		t.Fatalf("manual retry should continue existing thread, started threads: %+v", fake.threadInputs)
	}
	r.CancelIssue(issue.ID)
	waitIssueNotRunning(t, r, issue.ID)
}

func TestRunnerDoesNotFailOnCodexReconnectProgressError(t *testing.T) {
	st := openRunnerStore(t)
	ctx := context.Background()
	_, _ = st.CreateProject(ctx, store.Project{ID: "demo", Name: "Demo", CWD: t.TempDir(), AutoRun: 1})
	issue, _ := st.CreateIssue(ctx, store.Issue{ProjectID: "demo", Title: "network", Status: store.StatusTodo})
	fake := &fakeCodex{events: make(chan agent.Event, 8), manualEvents: true}
	r := New(st, events.NewBus(), fake)

	if err := r.StartProject("demo"); err != nil {
		t.Fatalf("start project: %v", err)
	}
	defer r.StopProject("demo")

	waitIssueRuntime(t, st, issue.ID, "thread-1", "turn-1")
	reason := "Reconnecting... 1/5 stream disconnected before completion: Upstream request failed"
	fake.events <- agent.Event{Method: "error", ThreadID: "thread-1", TurnID: "turn-1", Error: reason}

	after := assertIssueRemainsInProgress(t, st, issue.ID)
	if after.AutoRetryNextAt != "" || after.AutoRetryReason != "" || after.Error != "" {
		t.Fatalf("reconnect progress must not fail or auto-retry issue: %+v", after)
	}
	r.CancelIssue(issue.ID)
	waitIssueNotRunning(t, r, issue.ID)
}

func TestRunnerFailsTransientErrorWithoutAutoRetry(t *testing.T) {
	st := openRunnerStore(t)
	ctx := context.Background()
	_, _ = st.CreateProject(ctx, store.Project{ID: "demo", Name: "Demo", CWD: t.TempDir(), AutoRun: 1})
	issue, _ := st.CreateIssue(ctx, store.Issue{ProjectID: "demo", Title: "network", Status: store.StatusTodo})
	fake := &fakeCodex{events: make(chan agent.Event, 8), manualEvents: true}
	r := New(st, events.NewBus(), fake)

	if err := r.StartProject("demo"); err != nil {
		t.Fatalf("start project: %v", err)
	}
	defer r.StopProject("demo")

	waitIssueRuntime(t, st, issue.ID, "thread-1", "turn-1")
	reason := "Transport error: connection reset by peer"
	fake.events <- agent.Event{Method: "error", ThreadID: "thread-1", TurnID: "turn-1", Error: reason}

	got := waitIssueStatus(t, st, issue.ID, store.StatusFailed)
	if got.Error != reason || got.AutoRetryNextAt != "" || got.AutoRetryReason != "" {
		t.Fatalf("transient error should fail once without auto retry: %+v", got)
	}
}

func TestRunnerDoesNotAutoRetryPermissionDeniedError(t *testing.T) {
	st := openRunnerStore(t)
	ctx := context.Background()
	_, _ = st.CreateProject(ctx, store.Project{ID: "demo", Name: "Demo", CWD: t.TempDir(), AutoRun: 1})
	issue, _ := st.CreateIssue(ctx, store.Issue{ProjectID: "demo", Title: "denied", Status: store.StatusTodo})
	fake := &fakeCodex{events: make(chan agent.Event, 8), manualEvents: true}
	r := New(st, events.NewBus(), fake)

	if err := r.StartProject("demo"); err != nil {
		t.Fatalf("start project: %v", err)
	}
	defer r.StopProject("demo")

	waitIssueRuntime(t, st, issue.ID, "thread-1", "turn-1")
	fake.events <- agent.Event{Method: "error", ThreadID: "thread-1", TurnID: "turn-1", Error: "approval denied: permission denied"}

	got := waitIssueStatus(t, st, issue.ID, store.StatusFailed)
	if got.AutoRetryNextAt != "" || got.AutoRetryReason != "" {
		t.Fatalf("permission denied must not schedule auto retry: %+v", got)
	}
}

func TestRunnerFailsTransientErrorAfterMaxAutoRetryAttempts(t *testing.T) {
	st := openRunnerStore(t)
	ctx := context.Background()
	_, _ = st.CreateProject(ctx, store.Project{ID: "demo", Name: "Demo", CWD: t.TempDir(), AutoRun: 1})
	issue, _ := st.CreateIssue(ctx, store.Issue{ProjectID: "demo", Title: "max retry", Status: store.StatusTodo})
	advanceIssueAttempts(t, st, issue.ID, 2)
	fake := &fakeCodex{events: make(chan agent.Event, 8), manualEvents: true}
	r := New(st, events.NewBus(), fake)

	if err := r.StartProject("demo"); err != nil {
		t.Fatalf("start project: %v", err)
	}
	defer r.StopProject("demo")

	waitIssueRuntime(t, st, issue.ID, "thread-1", "turn-1")
	reason := "Transport error: connection reset by peer"
	fake.events <- agent.Event{Method: "error", ThreadID: "thread-1", TurnID: "turn-1", Error: reason}

	got := waitIssueStatus(t, st, issue.ID, store.StatusFailed)
	if got.AttemptCount != 3 || got.Error != reason ||
		got.AutoRetryNextAt != "" || got.AutoRetryReason != "" {
		t.Fatalf("max attempts should fail with original error: %+v", got)
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
	fake := &fakeCodex{events: make(chan agent.Event, 8), manualEvents: true}
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

func waitIssueAutoRetry(t *testing.T, st *store.Store, id int64) store.Issue {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		issue, _ := st.GetIssue(context.Background(), id)
		if issue.Status == store.StatusTodo && issue.AutoRetryNextAt != "" {
			return issue
		}
		time.Sleep(20 * time.Millisecond)
	}
	issue, _ := st.GetIssue(context.Background(), id)
	t.Fatalf("issue auto retry missing: %+v", issue)
	return issue
}

func assertIssueRemainsInProgress(t *testing.T, st *store.Store, id int64) store.Issue {
	t.Helper()
	time.Sleep(120 * time.Millisecond)
	issue, err := st.GetIssue(context.Background(), id)
	if err != nil {
		t.Fatalf("get issue: %v", err)
	}
	if issue.Status != store.StatusInProgress {
		t.Fatalf("issue status = %q, want in_progress: %+v", issue.Status, issue)
	}
	return issue
}

func assertAutoRetryEvent(t *testing.T, st *store.Store, issueID int64, reason string, attempt int) {
	t.Helper()
	events, err := st.ListIssueEvents(context.Background(), issueID)
	if err != nil {
		t.Fatalf("list issue events: %v", err)
	}
	for _, event := range events {
		if event.Type != "issue.auto_retry_scheduled" {
			continue
		}
		var payload struct {
			Reason      string `json:"reason"`
			NextRetryAt string `json:"next_retry_at"`
			Attempt     int    `json:"attempt"`
		}
		if err := json.Unmarshal([]byte(event.Payload), &payload); err != nil {
			t.Fatalf("decode auto retry payload: %v payload=%s", err, event.Payload)
		}
		if payload.Reason == reason && payload.NextRetryAt != "" && payload.Attempt == attempt {
			return
		}
		t.Fatalf("unexpected auto retry payload: %+v", payload)
	}
	t.Fatalf("missing issue.auto_retry_scheduled event: %+v", events)
}

func advanceIssueAttempts(t *testing.T, st *store.Store, issueID int64, attempts int) {
	t.Helper()
	for n := 0; n < attempts; n++ {
		if _, ok, err := st.ClaimNextIssue(context.Background(), "demo"); err != nil || !ok {
			t.Fatalf("advance claim %d: ok=%v err=%v", n+1, ok, err)
		}
		if _, err := st.SetIssueStatus(context.Background(), issueID, store.StatusTodo, ""); err != nil {
			t.Fatalf("reset attempt %d: %v", n+1, err)
		}
	}
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
