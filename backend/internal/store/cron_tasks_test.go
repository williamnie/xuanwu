package store

import (
	"context"
	"testing"
	"time"
)

func TestCronTaskLifecycle(t *testing.T) {
	st := openTestStore(t)
	ctx := context.Background()
	nextRun := time.Date(2026, 5, 21, 12, 0, 0, 0, time.UTC).Format(time.RFC3339)

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

	due, err := st.ListDueCronTasks(ctx, time.Date(2026, 5, 21, 12, 0, 1, 0, time.UTC))
	if err != nil || len(due) != 1 || due[0].ID != task.ID {
		t.Fatalf("due tasks = %+v err=%v", due, err)
	}

	ran, err := st.MarkCronTaskRan(ctx, task.ID, time.Date(2026, 5, 21, 12, 0, 2, 0, time.UTC))
	if err != nil {
		t.Fatalf("mark ran: %v", err)
	}
	if ran.Status != CronStatusDone || ran.RunCount != 1 || ran.NextRunAt != "" {
		t.Fatalf("once task should be done: %+v", ran)
	}
}

func TestDailyCronTaskKeepsActiveAndSchedulesNextDay(t *testing.T) {
	st := openTestStore(t)
	ctx := context.Background()
	firstRun := time.Date(2026, 5, 21, 4, 0, 0, 0, time.UTC)

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
