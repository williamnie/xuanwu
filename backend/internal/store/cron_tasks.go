package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"
)

var ErrCronTaskInvalid = errors.New("cron task 不合法")

func (s *Store) ListCronTasks(ctx context.Context) ([]CronTask, error) {
	rows, err := s.db.QueryContext(ctx, cronTaskSelect+` order by created_at desc`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanCronTasks(rows)
}

func (s *Store) ListDueCronTasks(ctx context.Context, dueAt time.Time) ([]CronTask, error) {
	rows, err := s.db.QueryContext(ctx, cronTaskSelect+`
		where status=? and next_run_at<>'' and next_run_at<=?
		order by next_run_at asc`, CronStatusActive, dueAt.UTC().Format(time.RFC3339))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanCronTasks(rows)
}

func (s *Store) GetCronTask(ctx context.Context, id int64) (CronTask, error) {
	row := s.db.QueryRowContext(ctx, cronTaskSelect+` where id=?`, id)
	task, err := scanCronTask(row)
	if errors.Is(err, sql.ErrNoRows) {
		return CronTask{}, ErrNotFound
	}
	return task, err
}

func (s *Store) CreateCronTask(ctx context.Context, task CronTask) (CronTask, error) {
	if err := normalizeCronTask(&task, time.Now().UTC()); err != nil {
		return CronTask{}, err
	}
	t := now()
	_, err := s.db.ExecContext(ctx, `insert into cron_tasks
		(name, project_id, action, mode, time_of_day, next_run_at,
		status, error, created_at, updated_at)
		values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		task.Name, task.ProjectID, task.Action, task.Mode, task.TimeOfDay,
		task.NextRunAt, task.Status, task.Error, t, t)
	if err != nil {
		return CronTask{}, err
	}
	id, err := lastInsertID(ctx, s.db)
	if err != nil {
		return CronTask{}, err
	}
	return s.GetCronTask(ctx, id)
}

func (s *Store) UpdateCronTask(ctx context.Context, id int64, patch CronTaskPatch) (CronTask, error) {
	task, err := s.GetCronTask(ctx, id)
	if err != nil {
		return CronTask{}, err
	}
	applyCronTaskPatch(&task, patch)
	if err := normalizeCronTask(&task, time.Now().UTC()); err != nil {
		return CronTask{}, err
	}
	_, err = s.db.ExecContext(ctx, `update cron_tasks set name=?, project_id=?,
		action=?, mode=?, time_of_day=?, next_run_at=?, status=?, error=?,
		updated_at=? where id=?`, task.Name, task.ProjectID, task.Action,
		task.Mode, task.TimeOfDay, task.NextRunAt, task.Status, task.Error, now(), id)
	if err != nil {
		return CronTask{}, err
	}
	return s.GetCronTask(ctx, id)
}

func (s *Store) DeleteCronTask(ctx context.Context, id int64) error {
	res, err := s.db.ExecContext(ctx, `delete from cron_tasks where id=?`, id)
	if err != nil {
		return err
	}
	return requireAffected(res)
}

func (s *Store) MarkCronTaskRan(ctx context.Context, id int64, ranAt time.Time) (CronTask, error) {
	task, err := s.GetCronTask(ctx, id)
	if err != nil {
		return CronTask{}, err
	}
	nextRun, status, err := nextCronRunAfter(task, ranAt)
	if err != nil {
		return CronTask{}, err
	}
	_, err = s.db.ExecContext(ctx, `update cron_tasks set last_run_at=?,
		next_run_at=?, status=?, run_count=run_count+1, error='', updated_at=?
		where id=?`, ranAt.UTC().Format(time.RFC3339), nextRun, status, now(), id)
	if err != nil {
		return CronTask{}, err
	}
	return s.GetCronTask(ctx, id)
}

func (s *Store) MarkCronTaskError(ctx context.Context, id int64, errText string) error {
	_, err := s.db.ExecContext(ctx, `update cron_tasks set error=?, updated_at=? where id=?`,
		strings.TrimSpace(errText), now(), id)
	return err
}

func scanCronTasks(rows *sql.Rows) ([]CronTask, error) {
	tasks := []CronTask{}
	for rows.Next() {
		task, err := scanCronTask(rows)
		if err != nil {
			return nil, err
		}
		tasks = append(tasks, task)
	}
	return tasks, rows.Err()
}

func applyCronTaskPatch(task *CronTask, patch CronTaskPatch) {
	if patch.Name != nil {
		task.Name = *patch.Name
	}
	if patch.ProjectID != nil {
		task.ProjectID = *patch.ProjectID
	}
	if patch.Action != nil {
		task.Action = *patch.Action
	}
	if patch.Mode != nil {
		task.Mode = *patch.Mode
	}
	if patch.TimeOfDay != nil {
		task.TimeOfDay = *patch.TimeOfDay
	}
	if patch.NextRunAt != nil {
		task.NextRunAt = *patch.NextRunAt
	}
	if patch.Status != nil {
		task.Status = *patch.Status
	}
	if patch.Error != nil {
		task.Error = *patch.Error
	}
}

func normalizeCronTask(task *CronTask, base time.Time) error {
	task.Name = strings.TrimSpace(task.Name)
	task.ProjectID = strings.TrimSpace(task.ProjectID)
	task.Action = strings.TrimSpace(task.Action)
	task.Mode = strings.TrimSpace(task.Mode)
	task.Status = strings.TrimSpace(task.Status)
	if task.Action == "" {
		task.Action = CronActionTriageToTodo
	}
	if task.Mode == "" {
		task.Mode = CronModeOnce
	}
	if task.Status == "" {
		task.Status = CronStatusActive
	}
	if err := validateCronTask(task); err != nil {
		return err
	}
	return normalizeCronRunTime(task, base)
}

func validateCronTask(task *CronTask) error {
	if task.Action != CronActionTriageToTodo {
		return fmt.Errorf("%w: unsupported action %q", ErrCronTaskInvalid, task.Action)
	}
	if task.Mode != CronModeOnce && task.Mode != CronModeDaily {
		return fmt.Errorf("%w: unsupported mode %q", ErrCronTaskInvalid, task.Mode)
	}
	if task.Status != CronStatusActive && task.Status != CronStatusPaused &&
		task.Status != CronStatusDone {
		return fmt.Errorf("%w: unsupported status %q", ErrCronTaskInvalid, task.Status)
	}
	return nil
}

func normalizeCronRunTime(task *CronTask, base time.Time) error {
	if task.NextRunAt != "" {
		t, err := time.Parse(time.RFC3339, strings.TrimSpace(task.NextRunAt))
		if err != nil {
			return fmt.Errorf("%w: next_run_at 需要 RFC3339", ErrCronTaskInvalid)
		}
		task.NextRunAt = t.UTC().Format(time.RFC3339)
	}
	if task.Mode == CronModeDaily {
		return normalizeDailyCronRunTime(task, base)
	}
	if task.NextRunAt == "" && task.Status == CronStatusActive {
		return fmt.Errorf("%w: once 任务需要 next_run_at", ErrCronTaskInvalid)
	}
	if task.Name == "" {
		task.Name = defaultCronTaskName(task)
	}
	return nil
}

func normalizeDailyCronRunTime(task *CronTask, base time.Time) error {
	if task.TimeOfDay == "" && task.NextRunAt != "" {
		t, _ := time.Parse(time.RFC3339, task.NextRunAt)
		task.TimeOfDay = t.In(time.Local).Format("15:04")
	}
	if _, _, err := parseTimeOfDay(task.TimeOfDay); err != nil {
		return err
	}
	if task.NextRunAt == "" && task.Status == CronStatusActive {
		next, err := NextDailyCronRun(task.TimeOfDay, base)
		if err != nil {
			return err
		}
		task.NextRunAt = next.UTC().Format(time.RFC3339)
	}
	if task.Name == "" {
		task.Name = defaultCronTaskName(task)
	}
	return nil
}

func nextCronRunAfter(task CronTask, ranAt time.Time) (string, string, error) {
	if task.Mode == CronModeOnce {
		return "", CronStatusDone, nil
	}
	next, err := NextDailyCronRun(task.TimeOfDay, ranAt)
	if err != nil {
		return "", "", err
	}
	return next.UTC().Format(time.RFC3339), CronStatusActive, nil
}

func NextDailyCronRun(timeOfDay string, after time.Time) (time.Time, error) {
	hour, minute, err := parseTimeOfDay(timeOfDay)
	if err != nil {
		return time.Time{}, err
	}
	localAfter := after.In(time.Local)
	next := time.Date(localAfter.Year(), localAfter.Month(), localAfter.Day(),
		hour, minute, 0, 0, time.Local)
	if !next.After(localAfter) {
		next = next.AddDate(0, 0, 1)
	}
	return next, nil
}

func parseTimeOfDay(value string) (int, int, error) {
	t, err := time.Parse("15:04", strings.TrimSpace(value))
	if err != nil {
		return 0, 0, fmt.Errorf("%w: time_of_day 需要 HH:MM", ErrCronTaskInvalid)
	}
	return t.Hour(), t.Minute(), nil
}

func defaultCronTaskName(task *CronTask) string {
	scope := "所有项目"
	if task.ProjectID != "" {
		scope = task.ProjectID
	}
	if task.Mode == CronModeDaily {
		return "每日运行 Triage - " + scope
	}
	return "定时运行 Triage - " + scope
}

const cronTaskSelect = `select id, name, project_id, action, mode, time_of_day,
	next_run_at, last_run_at, status, run_count, error, created_at, updated_at
	from cron_tasks`
