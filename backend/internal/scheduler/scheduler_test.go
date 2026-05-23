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
	if len(starter.started) != 1 || starter.started[0] != "demo" {
		t.Fatalf("started projects: %+v", starter.started)
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
