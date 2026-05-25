package scheduler

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/xiaobei/codex-issue-runner/backend/internal/events"
	"github.com/xiaobei/codex-issue-runner/backend/internal/store"
)

func TestRunDueWithNoDueTasksDoesNothing(t *testing.T) {
	st := openSchedulerStore(t)
	ctx := context.Background()
	futureRun := time.Now().UTC().Add(time.Hour)
	task, err := st.CreateCronTask(ctx, store.CronTask{
		Name:      "future triage",
		ProjectID: "demo",
		Mode:      store.CronModeOnce,
		NextRunAt: futureRun.Format(time.RFC3339),
	})
	if err != nil {
		t.Fatalf("create cron task: %v", err)
	}

	starter := &fakeStarter{}
	s := New(st, events.NewBus(), starter)
	if err := s.RunDue(ctx, futureRun.Add(-time.Minute)); err != nil {
		t.Fatalf("run due: %v", err)
	}

	got, _ := st.GetCronTask(ctx, task.ID)
	if got.RunCount != 0 || got.Status != store.CronStatusActive || got.Error != "" {
		t.Fatalf("future task should be untouched: %+v", got)
	}
	if len(starter.started) != 0 {
		t.Fatalf("started projects: %+v", starter.started)
	}
}

func TestRunDueRecordsStarterFailure(t *testing.T) {
	st := openSchedulerStore(t)
	ctx := context.Background()
	_, _ = st.CreateProject(ctx, store.Project{ID: "demo", Name: "Demo", CWD: t.TempDir()})
	issue, _ := st.CreateIssue(ctx, store.Issue{ProjectID: "demo", Title: "queued later", Status: store.StatusTriage})
	task := createDueCronTask(t, st, "demo")

	starter := &fakeStarter{err: errors.New("runner unavailable")}
	s := New(st, events.NewBus(), starter)
	if err := s.RunDue(ctx, time.Now().UTC().Add(time.Hour)); err != nil {
		t.Fatalf("run due should record task errors and continue: %v", err)
	}

	gotIssue, _ := st.GetIssue(ctx, issue.ID)
	if gotIssue.Status != store.StatusTodo {
		t.Fatalf("issue status = %s, want todo", gotIssue.Status)
	}
	gotTask, _ := st.GetCronTask(ctx, task.ID)
	if gotTask.RunCount != 0 || gotTask.Error != "runner unavailable" {
		t.Fatalf("task should record starter error without marking ran: %+v", gotTask)
	}
	if gotTask.LastStatus != store.CronLastStatusFailed || gotTask.LastRunAt == "" {
		t.Fatalf("task failure result not recorded: %+v", gotTask)
	}
}

func createDueCronTask(t *testing.T, st *store.Store, projectID string) store.CronTask {
	t.Helper()
	dueAt := time.Now().UTC().Add(time.Hour)
	task, err := st.CreateCronTask(context.Background(), store.CronTask{
		Name:      "run demo triage",
		ProjectID: projectID,
		Mode:      store.CronModeOnce,
		NextRunAt: dueAt.Add(-time.Minute).Format(time.RFC3339),
	})
	if err != nil {
		t.Fatalf("create cron task: %v", err)
	}
	return task
}
