package scheduler

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/xiaobei/codex-issue-runner/backend/internal/events"
	"github.com/xiaobei/codex-issue-runner/backend/internal/store"
)

const defaultInterval = 30 * time.Second

type ProjectStarter interface {
	StartProject(projectID string) error
}

type Scheduler struct {
	store    *store.Store
	bus      *events.Bus
	starter  ProjectStarter
	interval time.Duration
}

func New(st *store.Store, bus *events.Bus, starter ProjectStarter) *Scheduler {
	return &Scheduler{store: st, bus: bus, starter: starter, interval: defaultInterval}
}

func (s *Scheduler) Start(ctx context.Context) {
	go s.loop(ctx)
}

func (s *Scheduler) RunDue(ctx context.Context, dueAt time.Time) error {
	tasks, err := s.store.ListDueCronTasks(ctx, dueAt)
	if err != nil {
		return err
	}
	for _, task := range tasks {
		if err := s.runTask(ctx, task, dueAt); err != nil {
			_ = s.store.MarkCronTaskError(ctx, task.ID, err.Error())
			s.publishTaskEvent("cron_task.error", task, 0, err.Error())
		}
	}
	return nil
}

func (s *Scheduler) loop(ctx context.Context) {
	ticker := time.NewTicker(s.interval)
	defer ticker.Stop()
	for {
		if err := s.RunDue(ctx, time.Now().UTC()); err != nil {
			s.bus.Publish(events.AppEvent{Type: "cron_task.error", Error: err.Error()})
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func (s *Scheduler) runTask(ctx context.Context, task store.CronTask, dueAt time.Time) error {
	if task.Action != store.CronActionTriageToTodo {
		return fmt.Errorf("unsupported cron action: %s", task.Action)
	}
	issues, err := s.store.PromoteTriageToTodo(ctx, task.ProjectID)
	if err != nil {
		return err
	}
	s.recordPromotedIssues(ctx, issues)
	for projectID := range affectedProjects(issues) {
		_ = s.starter.StartProject(projectID)
	}
	if _, err = s.store.MarkCronTaskRan(ctx, task.ID, dueAt); err != nil {
		return err
	}
	s.publishTaskEvent("cron_task.ran", task, len(issues), "")
	return nil
}

func (s *Scheduler) recordPromotedIssues(ctx context.Context, issues []store.Issue) {
	for _, issue := range issues {
		payload := map[string]string{"status": store.StatusTodo}
		payloadText := mustJSON(payload)
		event, err := s.store.AddIssueEvent(ctx, issue.ID, "issue.status_changed", payloadText)
		if err != nil {
			continue
		}
		s.bus.Publish(events.AppEvent{
			ID: event.ID, Type: "issue.status_changed", IssueID: issue.ID,
			ProjectID: issue.ProjectID, Status: store.StatusTodo, CreatedAt: event.CreatedAt,
		})
	}
}

func (s *Scheduler) publishTaskEvent(typ string, task store.CronTask, count int, errText string) {
	payload := map[string]any{"task_id": task.ID, "promoted": count}
	s.bus.Publish(events.AppEvent{
		Type: typ, ProjectID: task.ProjectID, Status: task.Status,
		Text: fmt.Sprintf("%d issue(s) promoted", count), Error: errText,
		Payload: mustJSON(payload), CreatedAt: time.Now().UTC().Format(time.RFC3339),
	})
}

func affectedProjects(issues []store.Issue) map[string]bool {
	projects := map[string]bool{}
	for _, issue := range issues {
		projects[issue.ProjectID] = true
	}
	return projects
}

func mustJSON(value any) string {
	body, err := json.Marshal(value)
	if err != nil {
		return "{}"
	}
	return string(body)
}
