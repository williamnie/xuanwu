package store

import (
	"context"
	"database/sql"
	"errors"
	"path/filepath"
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

	ran, err := st.MarkCronTaskRan(ctx, task.ID, CronTaskRunRecord{
		RanAt:      dueAt.Add(2 * time.Second),
		LastResult: "已转入 Todo: #42",
	})
	if err != nil {
		t.Fatalf("mark ran: %v", err)
	}
	if ran.Status != CronStatusDone || ran.RunCount != 1 || ran.NextRunAt != "" {
		t.Fatalf("once task should be done: %+v", ran)
	}
	if ran.LastStatus != CronLastStatusSuccess || ran.LastResult != "已转入 Todo: #42" {
		t.Fatalf("last run result not recorded: %+v", ran)
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
	ran, err := st.MarkCronTaskRan(ctx, task.ID, CronTaskRunRecord{RanAt: firstRun})
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

func TestMarkCronTaskErrorRecordsLastFailure(t *testing.T) {
	st := openTestStore(t)
	ctx := context.Background()
	nextRun := time.Now().UTC().Add(time.Hour).Format(time.RFC3339)
	task, err := st.CreateCronTask(ctx, CronTask{Mode: CronModeOnce, NextRunAt: nextRun})
	if err != nil {
		t.Fatalf("create cron task: %v", err)
	}
	ranAt := time.Now().UTC().Add(2 * time.Hour)
	if err := st.MarkCronTaskError(ctx, task.ID, ranAt, "runner unavailable"); err != nil {
		t.Fatalf("mark cron task error: %v", err)
	}

	got, err := st.GetCronTask(ctx, task.ID)
	if err != nil {
		t.Fatalf("get cron task: %v", err)
	}
	if got.LastRunAt != ranAt.Format(time.RFC3339) || got.LastStatus != CronLastStatusFailed {
		t.Fatalf("failure run metadata not recorded: %+v", got)
	}
	if got.Error != "runner unavailable" || got.RunCount != 0 {
		t.Fatalf("unexpected failure record: %+v", got)
	}
}

func TestOpenMigratesCronTaskLastResultColumns(t *testing.T) {
	path := filepath.Join(t.TempDir(), "old.db")
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatalf("open old db: %v", err)
	}
	_, err = db.Exec(`create table cron_tasks (
		id integer primary key autoincrement, name text not null,
		project_id text not null default '', action text not null,
		mode text not null, time_of_day text not null default '',
		next_run_at text not null default '', last_run_at text not null default '',
		status text not null, run_count integer not null default 0,
		error text not null default '', created_at text not null, updated_at text not null
	);
	insert into cron_tasks (name, action, mode, next_run_at, status, created_at, updated_at)
		values ('legacy cron', 'triage_to_todo', 'once',
		'2026-05-26T04:00:00Z', 'active',
		'2026-05-26T03:00:00Z', '2026-05-26T03:00:00Z');`)
	if closeErr := db.Close(); err != nil || closeErr != nil {
		t.Fatalf("seed old cron db: exec=%v close=%v", err, closeErr)
	}

	st, err := Open(path)
	if err != nil {
		t.Fatalf("open migrated store: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })
	task, err := st.GetCronTask(context.Background(), 1)
	if err != nil {
		t.Fatalf("get migrated cron task: %v", err)
	}
	if task.LastStatus != "" || task.LastResult != "" {
		t.Fatalf("legacy cron last result should start empty: %+v", task)
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
