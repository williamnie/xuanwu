package runner

import (
	"context"
	"encoding/json"
	"strings"
	"time"

	"github.com/xiaobei/codex-issue-runner/backend/internal/agent"
	"github.com/xiaobei/codex-issue-runner/backend/internal/events"
	"github.com/xiaobei/codex-issue-runner/backend/internal/store"
)

type IssueInterruptRequest struct {
	IssueID           int64
	Status            string
	RunStatus         string
	ExitReason        string
	EventType         string
	ErrorMessage      string
	RecordStatusEvent bool
}

type IssueInterruptResult struct {
	Issue       store.Issue
	Interrupted bool
}

func (r *Runner) InterruptIssue(ctx context.Context, req IssueInterruptRequest) (IssueInterruptResult, error) {
	issue, err := r.store.GetIssue(ctx, req.IssueID)
	if err != nil {
		return IssueInterruptResult{}, err
	}
	if strings.TrimSpace(issue.CodexThreadID) == "" || strings.TrimSpace(issue.CodexTurnID) == "" {
		r.recordInterruptEvent(ctx, issue.ID, interruptIssueEvent{
			Type: req.EventType, Reason: req.ExitReason,
		})
		updated, updateErr := r.updateInterruptedIssue(ctx, req, issue)
		if updateErr != nil {
			return IssueInterruptResult{Issue: updated}, updateErr
		}
		if req.RecordStatusEvent {
			r.recordStatusEvent(ctx, issue.ID, updated.Status)
		}
		r.recordInterruptEvent(ctx, issue.ID, interruptIssueEvent{
			Type: "issue.interrupted", Reason: req.ExitReason,
		})
		return IssueInterruptResult{Issue: updated}, nil
	}
	r.recordInterruptEvent(ctx, issue.ID, interruptIssueEvent{
		Type: req.EventType, ThreadID: issue.CodexThreadID, TurnID: issue.CodexTurnID,
		Reason: req.ExitReason,
	})
	r.cancelRunningIssue(issue.ID)
	interruptErr := r.interruptTurnWithTimeout(ctx, issue.CodexThreadID, issue.CodexTurnID)
	if interruptErr != nil {
		r.recordInterruptFailed(ctx, issue.ID, issue.CodexThreadID, issue.CodexTurnID, req.ExitReason, interruptErr.Error())
	}
	updated, err := r.updateInterruptedIssue(ctx, req, issue)
	if err != nil {
		return IssueInterruptResult{}, err
	}
	if req.RecordStatusEvent {
		r.recordStatusEvent(ctx, issue.ID, updated.Status)
	}
	r.recordInterruptEvent(ctx, issue.ID, interruptIssueEvent{
		Type: "issue.interrupted", ThreadID: issue.CodexThreadID, TurnID: issue.CodexTurnID,
		Reason: req.ExitReason,
	})
	return IssueInterruptResult{Issue: updated, Interrupted: true}, nil
}

func (r *Runner) interruptTurnWithTimeout(ctx context.Context, threadID, turnID string) error {
	timeout := r.interruptTimeout
	if timeout <= 0 {
		timeout = 5 * time.Second
	}
	interruptCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- r.interruptTurn(interruptCtx, threadID, turnID) }()
	select {
	case err := <-done:
		return err
	case <-interruptCtx.Done():
		return interruptCtx.Err()
	}
}

func (r *Runner) InterruptSession(ctx context.Context, threadID string) (SessionInterruptResult, error) {
	if err := r.requireCapability(agent.CapabilityInterrupt); err != nil {
		return SessionInterruptResult{}, err
	}
	if linked, ok, err := r.linkedRunningIssue(ctx, threadID); err != nil || ok {
		if err != nil {
			return SessionInterruptResult{}, err
		}
		req := IssueInterruptRequest{
			IssueID: linked.ID, Status: store.StatusCancelled, RunStatus: store.StatusCancelled,
			ExitReason: "session_interrupt", EventType: "issue.interrupt_requested",
			RecordStatusEvent: true,
		}
		result, err := r.InterruptIssue(ctx, req)
		return SessionInterruptResult{Interrupted: result.Interrupted, Issue: &result.Issue}, err
	}
	state := r.sessionRunState(threadID)
	if state == nil || state.turnID == "" {
		return SessionInterruptResult{}, nil
	}
	go r.interruptTurn(context.Background(), threadID, state.turnID)
	return SessionInterruptResult{Interrupted: true}, nil
}

type SessionInterruptResult struct {
	Interrupted bool         `json:"interrupted"`
	Issue       *store.Issue `json:"issue,omitempty"`
}

func (r *Runner) updateInterruptedIssue(
	ctx context.Context,
	req IssueInterruptRequest,
	issue store.Issue,
) (store.Issue, error) {
	status := firstNonEmpty(req.Status, issue.Status)
	runStatus := firstNonEmpty(req.RunStatus, status)
	exitReason := firstNonEmpty(req.ExitReason, "interrupted")
	errText := strings.TrimSpace(req.ErrorMessage)
	return r.store.UpdateIssueClosingRunAs(ctx, issue.ID, store.IssuePatch{
		Status: &status, Error: &errText,
	}, runStatus, exitReason, errText)
}

func (r *Runner) linkedRunningIssue(ctx context.Context, threadID string) (store.Issue, bool, error) {
	issues, err := r.store.ListIssues(ctx, store.IssueFilter{Status: store.StatusInProgress})
	if err != nil {
		return store.Issue{}, false, err
	}
	for _, issue := range issues {
		if issue.CodexThreadID == threadID && issue.CodexTurnID != "" {
			return issue, true, nil
		}
	}
	return store.Issue{}, false, nil
}

func (r *Runner) cancelRunningIssue(issueID int64) {
	r.mu.Lock()
	state := r.running[issueID]
	r.mu.Unlock()
	if state != nil && state.cancel != nil {
		state.cancel()
	}
}

func (r *Runner) sessionRunState(threadID string) *runState {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.sessions[threadID]
}

type interruptIssueEvent struct {
	Type     string
	ThreadID string
	TurnID   string
	Reason   string
}

func (r *Runner) recordInterruptEvent(ctx context.Context, issueID int64, event interruptIssueEvent) {
	if event.Type == "" {
		return
	}
	payload, _ := json.Marshal(map[string]string{
		"thread_id": event.ThreadID,
		"turn_id":   event.TurnID,
		"reason":    firstNonEmpty(event.Reason, "interrupted"),
	})
	e, err := r.store.AddIssueEvent(ctx, issueID, event.Type, string(payload))
	if err != nil {
		return
	}
	r.bus.Publish(events.AppEvent{
		ID: e.ID, Type: e.Type, IssueID: issueID,
		ThreadID: event.ThreadID, TurnID: event.TurnID, Payload: e.Payload, CreatedAt: e.CreatedAt,
	})
}

func (r *Runner) recordInterruptFailed(ctx context.Context, issueID int64, threadID, turnID, reason, message string) {
	payload, _ := json.Marshal(map[string]string{
		"thread_id": threadID, "turn_id": turnID,
		"reason": firstNonEmpty(reason, "interrupted"), "error": message,
	})
	e, err := r.store.AddIssueEvent(ctx, issueID, "issue.interrupt_failed", string(payload))
	if err != nil {
		return
	}
	r.bus.Publish(events.AppEvent{
		ID: e.ID, Type: e.Type, IssueID: issueID,
		ThreadID: threadID, TurnID: turnID, Error: message, Payload: e.Payload, CreatedAt: e.CreatedAt,
	})
}
