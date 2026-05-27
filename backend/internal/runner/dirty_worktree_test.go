package runner

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/xiaobei/codex-issue-runner/backend/internal/agent"
	"github.com/xiaobei/codex-issue-runner/backend/internal/events"
	"github.com/xiaobei/codex-issue-runner/backend/internal/store"
)

func TestRunnerStartsIssueForCleanWorktree(t *testing.T) {
	st := openRunnerStore(t)
	ctx := context.Background()
	repo := initGitRepo(t)
	_, _ = st.CreateProject(ctx, store.Project{ID: "demo", Name: "Demo", CWD: repo, AutoRun: 1})
	issue, _ := st.CreateIssue(ctx, store.Issue{ProjectID: "demo", Title: "clean", Status: store.StatusTodo})
	fake := &fakeCodex{events: make(chan agent.Event, 8), manualEvents: true}
	r := New(st, events.NewBus(), fake)

	if err := r.StartProject("demo"); err != nil {
		t.Fatalf("start project: %v", err)
	}
	defer r.StopProject("demo")

	waitIssueRuntime(t, st, issue.ID, "thread-1", "turn-1")
	if len(fake.threadInputs) != 1 || fake.threadInputs[0].CWD != repo {
		t.Fatalf("clean worktree should start codex turn: %+v", fake.threadInputs)
	}
	explicitlyCompleteIssue(t, st, issue.ID)
	fake.events <- agent.Event{Method: "turn/completed", ThreadID: "thread-1", TurnID: "turn-1", Status: "completed"}
	waitIssueNotRunning(t, r, issue.ID)
}

func TestRunnerHoldsProjectOnDirtyWorktreeBeforeStartingIssue(t *testing.T) {
	st := openRunnerStore(t)
	ctx := context.Background()
	repo := initGitRepo(t)
	secret := "token=do-not-leak"
	if err := os.WriteFile(filepath.Join(repo, "scratch.txt"), []byte(secret), 0o600); err != nil {
		t.Fatalf("write dirty file: %v", err)
	}
	_, _ = st.CreateProject(ctx, store.Project{ID: "demo", Name: "Demo", CWD: repo, AutoRun: 1})
	issue, _ := st.CreateIssue(ctx, store.Issue{ProjectID: "demo", Title: "dirty", Status: store.StatusTodo, Priority: 2})
	next, _ := st.CreateIssue(ctx, store.Issue{ProjectID: "demo", Title: "must wait", Status: store.StatusTodo})
	fake := &fakeCodex{events: make(chan agent.Event, 8), manualEvents: true}
	r := New(st, events.NewBus(), fake)

	if err := r.StartProject("demo"); err != nil {
		t.Fatalf("start project: %v", err)
	}
	defer r.StopProject("demo")

	got := waitIssueError(t, st, issue.ID)
	if got.AttemptCount != 1 {
		t.Fatalf("dirty preflight should run after claim, issue = %+v", got)
	}
	project := waitProjectHold(t, st, "demo")
	if project.Hold.Reason != HoldReasonDirtyWorktree {
		t.Fatalf("project hold = %+v", project.Hold)
	}
	if !strings.Contains(got.Error, "未提交修改") || !strings.Contains(got.Error, "scratch.txt") {
		t.Fatalf("dirty error should mention uncommitted file, got %q", got.Error)
	}
	if strings.Contains(got.Error, secret) {
		t.Fatalf("dirty error leaked file content: %q", got.Error)
	}
	if len(fake.threadInputs) != 0 || len(fake.turnInputs) != 0 {
		t.Fatalf("dirty worktree must block before codex turn: threads=%+v turns=%+v", fake.threadInputs, fake.turnInputs)
	}
	unchanged, _ := st.GetIssue(ctx, next.ID)
	if unchanged.Status != store.StatusTodo || unchanged.AttemptCount != 0 {
		t.Fatalf("next issue should wait while project is held: %+v", unchanged)
	}
	waitRunnerHoldEventMentionsDirtyWorktree(t, st, issue.ID, secret)
}

func TestRunnerCanSkipDirtyWorktreeCheck(t *testing.T) {
	st := openRunnerStore(t)
	ctx := context.Background()
	repo := initGitRepo(t)
	if err := os.WriteFile(filepath.Join(repo, "scratch.txt"), []byte("dirty"), 0o600); err != nil {
		t.Fatalf("write dirty file: %v", err)
	}
	_, _ = st.CreateProject(ctx, store.Project{ID: "demo", Name: "Demo", CWD: repo, AutoRun: 1})
	issue, _ := st.CreateIssue(ctx, store.Issue{ProjectID: "demo", Title: "skip", Status: store.StatusTodo})
	fake := &fakeCodex{events: make(chan agent.Event, 8), manualEvents: true}
	r := New(st, events.NewBus(), fake)
	r.SetDirtyWorktreeCheckEnabled(false)

	if err := r.StartProject("demo"); err != nil {
		t.Fatalf("start project: %v", err)
	}
	defer r.StopProject("demo")

	waitIssueRuntime(t, st, issue.ID, "thread-1", "turn-1")
	if len(fake.threadInputs) != 1 {
		t.Fatalf("disabled dirty check should start codex turn: %+v", fake.threadInputs)
	}
}

func TestDirtyWorktreeHoldCheckWaitsForCleanWorktree(t *testing.T) {
	st := openRunnerStore(t)
	ctx := context.Background()
	repo := initGitRepo(t)
	scratch := filepath.Join(repo, "scratch.txt")
	if err := os.WriteFile(scratch, []byte("dirty"), 0o600); err != nil {
		t.Fatalf("write dirty file: %v", err)
	}
	_, _ = st.CreateProject(ctx, store.Project{ID: "demo", Name: "Demo", CWD: repo, AutoRun: 1})
	_, _ = st.SetProjectHold(ctx, "demo", store.ProjectHold{
		Reason: HoldReasonDirtyWorktree, Message: "dirty",
	})
	fake := &fakeCodex{events: make(chan agent.Event, 8)}
	r := New(st, events.NewBus(), fake)

	if err := r.CheckHeldProjects(ctx); err != nil {
		t.Fatalf("dirty hold check should continue scanning projects: %v", err)
	}
	stillHeld, _ := st.GetProject(ctx, "demo")
	if stillHeld.Hold == nil || !strings.Contains(stillHeld.Hold.LastCheckError, "scratch.txt") {
		t.Fatalf("dirty project should stay held with check error: %+v", stillHeld)
	}
	if len(fake.threadInputs) != 0 {
		t.Fatalf("dirty hold check should not start health thread: %+v", fake.threadInputs)
	}

	if err := os.Remove(scratch); err != nil {
		t.Fatalf("remove dirty file: %v", err)
	}
	fake.autoTurns = 1
	r.healthCheckWait = 20 * time.Millisecond
	if err := r.CheckHeldProjects(ctx); err != nil {
		t.Fatalf("clean hold check should clear dirty hold: %v", err)
	}
	cleared, _ := st.GetProject(ctx, "demo")
	if cleared.Hold != nil {
		t.Fatalf("hold should clear after clean worktree: %+v", cleared)
	}
}

func initGitRepo(t *testing.T) string {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is required for dirty worktree tests")
	}
	dir := t.TempDir()
	cmd := exec.Command("git", "init", "-q", dir)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git init: %v\n%s", err, out)
	}
	return dir
}

func waitRunnerHoldEventMentionsDirtyWorktree(
	t *testing.T,
	st *store.Store,
	issueID int64,
	secret string,
) {
	t.Helper()
	deadline := time.After(2 * time.Second)
	for {
		issueEvents, err := st.ListIssueEvents(context.Background(), issueID)
		if err != nil {
			t.Fatalf("list issue events: %v", err)
		}
		for _, event := range issueEvents {
			if event.Type != "runner.hold" {
				continue
			}
			if !strings.Contains(event.Payload, "未提交修改") || !strings.Contains(event.Payload, "scratch.txt") {
				t.Fatalf("runner.hold should mention dirty worktree, got %q", event.Payload)
			}
			if strings.Contains(event.Payload, secret) {
				t.Fatalf("runner.hold leaked file content: %q", event.Payload)
			}
			return
		}
		select {
		case <-deadline:
			t.Fatalf("missing runner.hold event: %+v", issueEvents)
		case <-time.After(20 * time.Millisecond):
		}
	}
}
