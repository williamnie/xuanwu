package runner

import (
	"context"
	"encoding/json"

	"github.com/xiaobei/codex-issue-runner/backend/internal/events"
	"github.com/xiaobei/codex-issue-runner/backend/internal/store"
)

func (r *Runner) setRunning(issueID int64, state *runState) {
	r.mu.Lock()
	r.running[issueID] = state
	r.mu.Unlock()
}

func (r *Runner) clearRunning(issueID int64) {
	r.mu.Lock()
	delete(r.running, issueID)
	r.mu.Unlock()
}

func (r *Runner) updateRuntime(ctx context.Context, issueID int64, threadID, turnID string) {
	_ = r.store.UpdateIssueRuntime(ctx, issueID, threadID, turnID)
	r.mu.Lock()
	if state := r.running[issueID]; state != nil {
		state.threadID = threadID
		state.turnID = turnID
	}
	r.mu.Unlock()
}

func (r *Runner) publishStatus(issueID int64, status string) {
	r.bus.Publish(events.AppEvent{Type: "issue.status_changed", IssueID: issueID, Status: status})
}

func (r *Runner) failIssue(ctx context.Context, issueID int64, message string) {
	if current, err := r.store.GetIssue(ctx, issueID); err == nil && current.Status == store.StatusCancelled {
		return
	}
	_, err := r.store.SetIssueStatus(ctx, issueID, store.StatusFailed, message)
	if err != nil {
		return
	}
	issue, err := r.recordStatusEvent(ctx, issueID, store.StatusFailed)
	if err == nil {
		r.notifyIssueStatus(ctx, issue)
	}
	r.recordErrorEvent(ctx, issueID, message)
}

func (r *Runner) recordStatusEvent(ctx context.Context, issueID int64, status string) (store.Issue, error) {
	payload, _ := json.Marshal(map[string]string{"status": status})
	e, err := r.store.AddIssueEvent(ctx, issueID, "issue.status_changed", string(payload))
	if err != nil {
		return store.Issue{}, err
	}
	r.bus.Publish(events.AppEvent{ID: e.ID, Type: e.Type, IssueID: issueID, Status: status, CreatedAt: e.CreatedAt})
	issue, err := r.store.GetIssue(ctx, issueID)
	if err != nil {
		return store.Issue{}, err
	}
	return issue, nil
}

func (r *Runner) recordErrorEvent(ctx context.Context, issueID int64, message string) {
	payload, _ := json.Marshal(map[string]string{"error": message})
	e, err := r.store.AddIssueEvent(ctx, issueID, "issue.error", string(payload))
	if err != nil {
		return
	}
	r.bus.Publish(events.AppEvent{ID: e.ID, Type: e.Type, IssueID: issueID, Error: message, CreatedAt: e.CreatedAt})
}

func developerInstructions() string {
	return "Codex Issue Runner 后台自动执行模式：保持改动最小，" +
		"优先验证，完成后给出简短总结；不要主动提交 git commit。"
}

func (r *Runner) notifyIssueStatus(ctx context.Context, issue store.Issue) {
	if r.notifier != nil {
		r.notifier.NotifyIssueStatus(ctx, issue)
	}
}
