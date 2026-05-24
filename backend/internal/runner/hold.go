package runner

import (
	"context"
	"encoding/json"
	"os"
	"time"

	"github.com/xiaobei/codex-issue-runner/backend/internal/agent"
	"github.com/xiaobei/codex-issue-runner/backend/internal/events"
	"github.com/xiaobei/codex-issue-runner/backend/internal/store"
)

const defaultHoldCheckInterval = 10 * time.Minute

func (r *Runner) holdIssue(ctx context.Context, issue store.Issue, reason holdReason) {
	if reason.NextCheckAt.IsZero() {
		reason.NextCheckAt = time.Now().UTC().Add(r.healthCheckInterval)
	}
	hold := store.ProjectHold{
		Reason:      reason.Kind,
		Message:     reason.Message,
		NextCheckAt: reason.NextCheckAt.UTC().Format(time.RFC3339),
	}
	_, _ = r.store.SetProjectHold(ctx, issue.ProjectID, hold)
	_, _ = r.store.ResetIssueForRunnerHold(ctx, issue.ID, reason.Message)
	r.recordStatusEvent(ctx, issue.ID, store.StatusTodo)
	r.recordRunnerHoldEvent(ctx, issue.ID, issue.ProjectID, reason)
	r.StopProject(issue.ProjectID)
}

func (r *Runner) recordRunnerHoldEvent(ctx context.Context, issueID int64, projectID string, reason holdReason) {
	payload, _ := json.Marshal(map[string]string{
		"project_id": projectID,
		"reason":     reason.Kind,
		"message":    reason.Message,
	})
	e, err := r.store.AddIssueEvent(ctx, issueID, "runner.hold", string(payload))
	if err == nil {
		r.bus.Publish(events.AppEvent{
			ID: e.ID, Type: e.Type, IssueID: issueID, ProjectID: projectID,
			Status: store.StatusTodo, Error: reason.Message, Payload: e.Payload,
			CreatedAt: e.CreatedAt,
		})
		return
	}
	r.bus.Publish(events.AppEvent{
		Type: "runner.hold", IssueID: issueID, ProjectID: projectID,
		Status: store.StatusTodo, Error: reason.Message, Payload: string(payload),
		CreatedAt: time.Now().UTC().Format(time.RFC3339),
	})
}

func (r *Runner) StartHoldChecks(ctx context.Context) {
	go r.holdCheckLoop(ctx)
}

func (r *Runner) holdCheckLoop(ctx context.Context) {
	ticker := time.NewTicker(r.healthCheckInterval)
	defer ticker.Stop()
	for {
		if err := r.checkDueHeldProjects(ctx); err != nil {
			r.bus.Publish(events.AppEvent{Type: "runner.hold_check.error", Error: err.Error()})
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func (r *Runner) CheckHeldProjects(ctx context.Context) error {
	projects, err := r.store.ListHeldProjects(ctx)
	if err != nil {
		return err
	}
	for _, project := range projects {
		r.checkHeldProject(ctx, project)
	}
	return nil
}

func (r *Runner) checkDueHeldProjects(ctx context.Context) error {
	projects, err := r.store.ListHeldProjectsDue(ctx, time.Now().UTC().Format(time.RFC3339))
	if err != nil {
		return err
	}
	for _, project := range projects {
		r.checkHeldProject(ctx, project)
	}
	return nil
}

func (r *Runner) checkHeldProject(ctx context.Context, project store.Project) {
	checkedAt := time.Now().UTC()
	if err := r.healthCheckProject(ctx, project); err != nil {
		next := checkedAt.Add(r.healthCheckInterval).Format(time.RFC3339)
		_, _ = r.store.UpdateProjectHoldCheck(ctx, project.ID, checkedAt.Format(time.RFC3339), next, err.Error())
		r.bus.Publish(events.AppEvent{
			Type: "runner.hold_check.failed", ProjectID: project.ID,
			Error: err.Error(), CreatedAt: checkedAt.Format(time.RFC3339),
		})
		return
	}
	cleared, err := r.store.ClearProjectHold(ctx, project.ID)
	if err != nil {
		return
	}
	r.bus.Publish(events.AppEvent{
		Type: "runner.hold_cleared", ProjectID: project.ID,
		CreatedAt: checkedAt.Format(time.RFC3339),
	})
	if cleared.AutoRun == 1 {
		_ = r.StartProject(project.ID)
	}
}

func (r *Runner) healthCheckProject(ctx context.Context, project store.Project) error {
	if err := r.agent.Start(ctx); err != nil {
		return err
	}
	r.ensureCodexEventPump()
	cwd, cleanup, err := healthCheckCWD()
	if err != nil {
		return err
	}
	defer cleanup()
	threadID, err := r.startThread(ctx, agent.ThreadInput{
		CWD: cwd, Model: project.Model, ApprovalPolicy: "never", Sandbox: "read-only",
		DeveloperInstructions: "Codex Issue Runner health check only. Do not modify files.",
		ThreadSource:          agent.ThreadSourceSubagent,
	})
	if err != nil {
		return err
	}
	eventsCh, unsubscribe := r.subscribeCodexEvents()
	defer unsubscribe()
	turnID, err := r.startTurn(ctx, threadID, []agent.UserInput{{
		Type: "text", Text: "Codex Issue Runner health check. Reply with ok only.",
	}}, agent.TurnOptions{ApprovalPolicy: "never", Sandbox: "read-only"})
	if err != nil {
		return err
	}
	return r.waitHealthTurn(ctx, threadID, turnID, eventsCh)
}

func (r *Runner) waitHealthTurn(ctx context.Context, threadID, turnID string, eventsCh <-chan agent.Event) error {
	timer := time.NewTimer(r.healthCheckWait)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-timer.C:
			_ = r.interruptTurn(context.Background(), threadID, turnID)
			return context.DeadlineExceeded
		case event := <-eventsCh:
			if !matches(event, threadID, turnID) {
				continue
			}
			if isAgentError(event) && event.Error != "" {
				return holdCheckErr(event.Error)
			}
			if !isAgentTurnCompleted(event) {
				continue
			}
			if event.Status == "completed" && event.Error == "" {
				return nil
			}
			if event.Error != "" {
				return holdCheckErr(event.Error)
			}
			return holdCheckErr("Codex health check ended with status: " + event.Status)
		}
	}
}

func healthCheckCWD() (string, func(), error) {
	dir, err := os.MkdirTemp("", "codex-runner-health-*")
	if err != nil {
		return "", func() {}, err
	}
	return dir, func() { _ = os.RemoveAll(dir) }, nil
}

type holdCheckErr string

func (e holdCheckErr) Error() string { return string(e) }
