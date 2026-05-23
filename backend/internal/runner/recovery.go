package runner

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/xiaobei/codex-issue-runner/backend/internal/codex"
	"github.com/xiaobei/codex-issue-runner/backend/internal/store"
)

func (r *Runner) RecoverInProgressIssues(ctx context.Context) error {
	issues, err := r.store.ListIssues(ctx, store.IssueFilter{Status: store.StatusInProgress})
	if err != nil {
		return err
	}
	for _, issue := range issues {
		r.recoverInProgressIssue(ctx, issue)
	}
	return nil
}

func (r *Runner) recoverInProgressIssue(ctx context.Context, issue store.Issue) {
	if strings.TrimSpace(issue.CodexThreadID) == "" {
		r.failUnrecoverableIssue(ctx, issue.ID, "missing codex_thread_id; issue marked failed after restart")
		return
	}
	r.recordRecoveryEvent(ctx, issue.ID, "issue.recovery_started", map[string]string{
		"thread_id": issue.CodexThreadID,
		"turn_id":   issue.CodexTurnID,
		"status":    issue.Status,
	})
	go r.resumeRecoveredIssue(issue)
}

func (r *Runner) failUnrecoverableIssue(ctx context.Context, issueID int64, reason string) {
	message := "Service restarted while issue was in progress"
	_, _ = r.store.SetIssueStatus(ctx, issueID, store.StatusFailed, message)
	r.recordStatusEvent(ctx, issueID, store.StatusFailed)
	r.recordErrorEvent(ctx, issueID, message)
	r.recordRecoveryEvent(ctx, issueID, "issue.recovery_failed", map[string]string{"error": reason})
}

func (r *Runner) resumeRecoveredIssue(issue store.Issue) {
	r.execMu.Lock()
	defer r.execMu.Unlock()
	ctx, cancel := context.WithCancel(context.Background())
	r.setRunning(issue.ID, &runState{cancel: cancel, threadID: issue.CodexThreadID, turnID: issue.CodexTurnID})
	defer r.clearRunning(issue.ID)
	r.publishStatus(issue.ID, store.StatusInProgress)
	if err := r.resumeIssueTurn(ctx, issue); err != nil {
		r.handleRecoveryError(ctx, issue, err)
	}
}

func (r *Runner) handleRecoveryError(ctx context.Context, issue store.Issue, err error) {
	r.recordRecoveryEvent(ctx, issue.ID, "issue.recovery_failed", map[string]string{
		"thread_id": issue.CodexThreadID,
		"turn_id":   issue.CodexTurnID,
		"error":     err.Error(),
	})
	if reason, ok := isRunnerHoldError(err.Error()); ok {
		r.holdIssue(ctx, issue, reason)
		return
	}
	r.failIssue(ctx, issue.ID, err.Error())
}

func (r *Runner) resumeIssueTurn(ctx context.Context, issue store.Issue) error {
	project, err := r.store.GetProject(ctx, issue.ProjectID)
	if err != nil {
		return err
	}
	eventsCh, unsubscribe, session, err := r.prepareRecoveredThread(ctx, issue.CodexThreadID)
	if err != nil {
		return err
	}
	defer unsubscribe()
	turnID, active := recoveredTurn(session, issue.CodexTurnID)
	if active {
		return r.attachRecoveredTurn(ctx, issue, session, turnID, eventsCh)
	}
	return r.startRecoveryTurn(ctx, issue, project, session, turnID, eventsCh)
}

func (r *Runner) prepareRecoveredThread(ctx context.Context, threadID string) (<-chan codex.Event, func(), codex.Session, error) {
	if err := r.codex.Start(ctx); err != nil {
		return nil, nil, codex.Session{}, err
	}
	r.ensureCodexEventPump()
	eventsCh, unsubscribe := r.subscribeCodexEvents()
	session, err := r.codex.ThreadResume(ctx, threadID)
	if err != nil {
		unsubscribe()
		return nil, nil, codex.Session{}, err
	}
	return eventsCh, unsubscribe, session, nil
}

func (r *Runner) attachRecoveredTurn(
	ctx context.Context,
	issue store.Issue,
	session codex.Session,
	turnID string,
	eventsCh <-chan codex.Event,
) error {
	threadID := r.updateRecoveredIssueRuntime(ctx, issue, session, turnID)
	r.recordRecoveryEvent(ctx, issue.ID, "issue.recovery_attached", map[string]string{
		"thread_id": threadID,
		"turn_id":   turnID,
	})
	return r.consumeEvents(ctx, issue.ID, threadID, turnID, eventsCh)
}

func (r *Runner) startRecoveryTurn(
	ctx context.Context,
	issue store.Issue,
	project store.Project,
	session codex.Session,
	previousTurnID string,
	eventsCh <-chan codex.Event,
) error {
	threadID := r.updateRecoveredIssueRuntime(ctx, issue, session, previousTurnID)
	if err := r.setRecoveredThreadName(ctx, threadID, issue); err != nil {
		return err
	}
	input, err := buildTurnInput(ctx, r.store, resumePrompt(project, issue))
	if err != nil {
		return err
	}
	turnID, err := r.codex.TurnStart(ctx, threadID, input, codex.TurnOptions{})
	if err != nil {
		return err
	}
	r.updateRuntime(ctx, issue.ID, threadID, turnID)
	r.recordRecoveryEvent(ctx, issue.ID, "issue.recovery_turn_started", map[string]string{
		"thread_id": threadID,
		"turn_id":   turnID,
	})
	return r.consumeEvents(ctx, issue.ID, threadID, turnID, eventsCh)
}

func (r *Runner) updateRecoveredIssueRuntime(
	ctx context.Context,
	issue store.Issue,
	session codex.Session,
	turnID string,
) string {
	threadID := firstNonEmpty(issue.CodexThreadID, session.ID)
	turnID = firstNonEmpty(turnID, issue.CodexTurnID, lastTurnID(session.Turns))
	r.updateRuntime(ctx, issue.ID, threadID, turnID)
	return threadID
}

func (r *Runner) setRecoveredThreadName(ctx context.Context, threadID string, issue store.Issue) error {
	if strings.TrimSpace(issue.Title) == "" {
		return nil
	}
	return r.codex.ThreadSetName(ctx, threadID, issue.Title)
}

func resumePrompt(project store.Project, issue store.Issue) string {
	return fmt.Sprintf(`服务重启后继续处理 issue #%d。

项目路径：%s

在继续前必须先检查当前工作区、git status、git diff、issue 状态和最近日志，例如：
- git status --short
- git diff
- codex-issue-runner issue status --id %d --json
- codex-issue-runner issue logs --id %d

请确认哪些步骤已经完成，避免重复已完成操作、重复 commit 或重复 side effect。
如果已有未完成上下文，请在现有 thread 内继续；完成后仍然必须执行 codex-issue-runner issue update 回写最终状态。`,
		issue.ID, project.CWD, issue.ID, issue.ID)
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if trimmed := strings.TrimSpace(value); trimmed != "" {
			return trimmed
		}
	}
	return ""
}

func lastTurnID(raw json.RawMessage) string {
	turnID, _ := lastTurnState(raw)
	return turnID
}

func lastTurnState(raw json.RawMessage) (string, string) {
	var turns []struct {
		ID     string `json:"id"`
		Status string `json:"status"`
	}
	if err := json.Unmarshal(raw, &turns); err != nil || len(turns) == 0 {
		return "", ""
	}
	last := turns[len(turns)-1]
	return strings.TrimSpace(last.ID), strings.TrimSpace(last.Status)
}

func recoveredTurn(session codex.Session, fallbackTurnID string) (string, bool) {
	turnID, status := lastTurnState(session.Turns)
	turnID = firstNonEmpty(turnID, fallbackTurnID)
	if turnID == "" {
		return "", false
	}
	active := strings.EqualFold(status, "inProgress") || codex.SessionStatusIsRunning(session.Status)
	return turnID, active
}
