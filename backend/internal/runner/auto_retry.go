package runner

import (
	"context"
	"encoding/json"
	"strings"
	"time"

	"github.com/xiaobei/codex-issue-runner/backend/internal/events"
	"github.com/xiaobei/codex-issue-runner/backend/internal/store"
)

const (
	maxAutoRetryAttempts  = 3
	defaultAutoRetryDelay = time.Minute
)

func (r *Runner) scheduleAutoRetryIfNeeded(ctx context.Context, issueID int64, err error) bool {
	if err == nil || !isTransientCodexTransportError(err.Error()) {
		return false
	}
	current, getErr := r.store.GetIssue(ctx, issueID)
	if getErr != nil || isTerminalStatus(current.Status) {
		return true
	}
	if current.AttemptCount >= maxAutoRetryAttempts {
		return false
	}
	nextAt := time.Now().UTC().Add(r.autoRetryDelay).Format(time.RFC3339Nano)
	issue, scheduleErr := r.store.ScheduleIssueAutoRetry(ctx, issueID, err.Error(), nextAt)
	if scheduleErr != nil {
		return false
	}
	r.recordStatusEvent(ctx, issueID, store.StatusTodo)
	r.recordAutoRetryEvent(ctx, issueID, err.Error(), nextAt, issue.AttemptCount+1)
	return true
}

func (r *Runner) recordAutoRetryEvent(ctx context.Context, issueID int64, reason, nextAt string, attempt int) {
	payload, _ := json.Marshal(map[string]any{
		"reason": reason, "next_retry_at": nextAt, "attempt": attempt,
	})
	e, err := r.store.AddIssueEvent(ctx, issueID, "issue.auto_retry_scheduled", string(payload))
	if err != nil {
		return
	}
	r.bus.Publish(events.AppEvent{
		ID: e.ID, Type: e.Type, IssueID: issueID, Status: store.StatusTodo,
		Payload: e.Payload, CreatedAt: e.CreatedAt,
	})
}

func isTransientCodexTransportError(message string) bool {
	lower := strings.ToLower(strings.TrimSpace(message))
	if lower == "" || isExplicitNonRetryError(lower) {
		return false
	}
	for _, token := range transientTransportTokens() {
		if strings.Contains(lower, token) {
			return true
		}
	}
	return lower == "eof"
}

func isExplicitNonRetryError(lower string) bool {
	for _, token := range []string{
		"explicit issue status update", "permission denied", "approval denied",
		"cancelled", "canceled", "runner paused", "usage limit", "authentication failed",
		"api returned 401", "api returned 429", "verification failed", "test failed",
		"tests failed", "exit status", "command timed out",
	} {
		if strings.Contains(lower, token) {
			return true
		}
	}
	return false
}

func transientTransportTokens() []string {
	return []string{
		"stream disconnected before completion", "transport error", "network error",
		"error decoding response body", "connection reset", "unexpected eof",
		": eof", " eof", "timeout", "timed out", "deadline exceeded",
	}
}
