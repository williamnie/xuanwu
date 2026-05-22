package store

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestCronTaskLifecycle(t *testing.T) {
	st := openTestStore(t)
	ctx := context.Background()
	nextRun := time.Now().UTC().Add(time.Hour).Format(time.RFC3339)

	task, err := st.CreateCronTask(ctx, CronTask{
		Name:      "午间运行 triage",
		ProjectID: "demo",
		Mode:      CronModeOnce,
		NextRunAt: nextRun,
	})
	if err != nil {
		t.Fatalf("create cron task: %v", err)
	}
	if task.Action != CronActionTriageToTodo || task.Status != CronStatusActive {
		t.Fatalf("unexpected defaults: %+v", task)
	}

	dueAt, _ := time.Parse(time.RFC3339, nextRun)
	due, err := st.ListDueCronTasks(ctx, dueAt.Add(time.Second))
	if err != nil || len(due) != 1 || due[0].ID != task.ID {
		t.Fatalf("due tasks = %+v err=%v", due, err)
	}

	ran, err := st.MarkCronTaskRan(ctx, task.ID, dueAt.Add(2*time.Second))
	if err != nil {
		t.Fatalf("mark ran: %v", err)
	}
	if ran.Status != CronStatusDone || ran.RunCount != 1 || ran.NextRunAt != "" {
		t.Fatalf("once task should be done: %+v", ran)
	}
}

func TestCreateCronTaskRejectsPastOnceRunAt(t *testing.T) {
	st := openTestStore(t)
	ctx := context.Background()
	pastRun := time.Now().UTC().Add(-time.Minute).Format(time.RFC3339)

	_, err := st.CreateCronTask(ctx, CronTask{
		Name:      "过去时间不应立即运行",
		ProjectID: "demo",
		Mode:      CronModeOnce,
		NextRunAt: pastRun,
	})
	if err == nil {
		t.Fatalf("expected past once run_at to be rejected")
	}
	if !errors.Is(err, ErrCronTaskInvalid) {
		t.Fatalf("expected ErrCronTaskInvalid, got %v", err)
	}
}

func TestDailyCronTaskKeepsActiveAndSchedulesNextDay(t *testing.T) {
	st := openTestStore(t)
	ctx := context.Background()
	firstRun := time.Now().UTC().Add(time.Hour)

	task, err := st.CreateCronTask(ctx, CronTask{
		Name:      "每日运行 triage",
		Mode:      CronModeDaily,
		TimeOfDay: "12:00",
		NextRunAt: firstRun.Format(time.RFC3339),
	})
	if err != nil {
		t.Fatalf("create daily cron task: %v", err)
	}
	ran, err := st.MarkCronTaskRan(ctx, task.ID, firstRun)
	if err != nil {
		t.Fatalf("mark daily ran: %v", err)
	}
	nextRun, err := time.Parse(time.RFC3339, ran.NextRunAt)
	if err != nil {
		t.Fatalf("parse next run: %v", err)
	}
	if ran.Status != CronStatusActive || ran.RunCount != 1 || !nextRun.After(firstRun) {
		t.Fatalf("daily task should stay active with future next run: %+v", ran)
	}
}

func TestPromoteTriageToTodoScopesProject(t *testing.T) {
	st := openTestStore(t)
	ctx := context.Background()
	_, _ = st.CreateProject(ctx, Project{ID: "demo", Name: "Demo", CWD: t.TempDir()})
	_, _ = st.CreateProject(ctx, Project{ID: "other", Name: "Other", CWD: t.TempDir()})
	demoTriage, _ := st.CreateIssue(ctx, Issue{ProjectID: "demo", Title: "demo triage", Status: StatusTriage})
	demoTodo, _ := st.CreateIssue(ctx, Issue{ProjectID: "demo", Title: "demo todo", Status: StatusTodo})
	otherTriage, _ := st.CreateIssue(ctx, Issue{ProjectID: "other", Title: "other triage", Status: StatusTriage})

	promoted, err := st.PromoteTriageToTodo(ctx, "demo")
	if err != nil {
		t.Fatalf("promote triage: %v", err)
	}
	if len(promoted) != 1 || promoted[0].ID != demoTriage.ID || promoted[0].Status != StatusTodo {
		t.Fatalf("unexpected promoted issues: %+v", promoted)
	}

	unchangedTodo, _ := st.GetIssue(ctx, demoTodo.ID)
	unchangedOther, _ := st.GetIssue(ctx, otherTriage.ID)
	if unchangedTodo.Status != StatusTodo || unchangedOther.Status != StatusTriage {
		t.Fatalf("unexpected statuses: todo=%+v other=%+v", unchangedTodo, unchangedOther)
	}
}
