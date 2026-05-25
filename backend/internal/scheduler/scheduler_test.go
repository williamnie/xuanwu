package scheduler

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"github.com/xiaobei/codex-issue-runner/backend/internal/events"
	"github.com/xiaobei/codex-issue-runner/backend/internal/store"
)

type fakeStarter struct {
	started []string
	err     error
}

func (f *fakeStarter) StartProject(projectID string) error {
	f.started = append(f.started, projectID)
	return f.err
}

func TestRunDuePromotesTriageIssuesAndStartsProjects(t *testing.T) {
	st := openSchedulerStore(t)
	ctx := context.Background()
	_, _ = st.CreateProject(ctx, store.Project{ID: "demo", Name: "Demo", CWD: t.TempDir()})
	issue, _ := st.CreateIssue(ctx, store.Issue{ProjectID: "demo", Title: "queued later", Status: store.StatusTriage})
	dueAt := time.Now().UTC().Add(time.Hour)
	task, err := st.CreateCronTask(ctx, store.CronTask{
		Name:      "run demo triage",
		ProjectID: "demo",
		Mode:      store.CronModeOnce,
		NextRunAt: dueAt.Add(-time.Minute).Format(time.RFC3339),
	})
	if err != nil {
		t.Fatalf("create cron task: %v", err)
	}

	starter := &fakeStarter{}
	s := New(st, events.NewBus(), starter)
	if err := s.RunDue(ctx, dueAt); err != nil {
		t.Fatalf("run due: %v", err)
	}

	got, _ := st.GetIssue(ctx, issue.ID)
	if got.Status != store.StatusTodo {
		t.Fatalf("issue status = %s, want todo", got.Status)
	}
	events, _ := st.ListIssueEvents(ctx, issue.ID)
	if len(events) != 1 || events[0].Type != "issue.status_changed" {
		t.Fatalf("expected status event: %+v", events)
	}
	done, _ := st.GetCronTask(ctx, task.ID)
	if done.Status != store.CronStatusDone || done.RunCount != 1 {
		t.Fatalf("task not completed: %+v", done)
	}
	if done.LastStatus != store.CronLastStatusSuccess || done.LastResult != "已转入 Todo: #1" {
		t.Fatalf("task last result not recorded: %+v", done)
	}
	if len(starter.started) != 1 || starter.started[0] != "demo" {
		t.Fatalf("started projects: %+v", starter.started)
	}
}

func TestRunDueSkipsHeldProjectWithoutPromotingIssues(t *testing.T) {
	st := openSchedulerStore(t)
	ctx := context.Background()
	_, _ = st.CreateProject(ctx, store.Project{ID: "demo", Name: "Demo", CWD: t.TempDir()})
	_, _ = st.SetProjectHold(ctx, "demo", store.ProjectHold{
		Reason:  "usage_limit",
		Message: "Runner paused: usage limit reached",
	})
	issue, _ := st.CreateIssue(ctx, store.Issue{ProjectID: "demo", Title: "queued later", Status: store.StatusTriage})
	task := createDueCronTask(t, st, "demo")

	starter := &fakeStarter{}
	s := New(st, events.NewBus(), starter)
	if err := s.RunDue(ctx, time.Now().UTC().Add(time.Hour)); err != nil {
		t.Fatalf("run due: %v", err)
	}

	got, _ := st.GetIssue(ctx, issue.ID)
	if got.Status != store.StatusTriage {
		t.Fatalf("held project issue status = %s, want triage", got.Status)
	}
	ran, _ := st.GetCronTask(ctx, task.ID)
	if ran.Status != store.CronStatusDone || ran.RunCount != 1 || ran.Error != "" {
		t.Fatalf("held project cron should be recorded without error: %+v", ran)
	}
	if ran.LastStatus != store.CronLastStatusSkipped || ran.LastResult == "" {
		t.Fatalf("held project skip result not recorded: %+v", ran)
	}
	if len(starter.started) != 0 {
		t.Fatalf("held project should not start runner: %+v", starter.started)
	}
}

func openSchedulerStore(t *testing.T) *store.Store {
	t.Helper()
	st, err := store.Open(filepath.Join(t.TempDir(), "app.db"))
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })
	return st
}
