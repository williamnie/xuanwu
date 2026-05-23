package runner

import (
	"context"
	"encoding/json"
	"errors"
	"strconv"
	"strings"

	"github.com/xiaobei/codex-issue-runner/backend/internal/codex"
	"github.com/xiaobei/codex-issue-runner/backend/internal/events"
	"github.com/xiaobei/codex-issue-runner/backend/internal/store"
)

func (r *Runner) runIssue(issue store.Issue) {
	r.execMu.Lock()
	defer r.execMu.Unlock()
	ctx, cancel := context.WithCancel(context.Background())
	r.setRunning(issue.ID, &runState{cancel: cancel})
	defer r.clearRunning(issue.ID)
	r.publishStatus(issue.ID, store.StatusInProgress)
	project, err := r.store.GetProject(ctx, issue.ProjectID)
	if err != nil {
		r.failIssue(ctx, issue.ID, err.Error())
		return
	}
	if err := r.startCodexTurn(ctx, issue, project); err != nil {
		var holdErr runnerHoldError
		if errors.As(err, &holdErr) {
			r.holdIssue(ctx, issue, holdErr.reason)
			return
		}
		if reason, ok := isRunnerHoldError(err.Error()); ok {
			r.holdIssue(ctx, issue, reason)
			return
		}
		if r.scheduleAutoRetryIfNeeded(ctx, issue.ID, err) {
			return
		}
		r.failIssue(ctx, issue.ID, err.Error())
	}
}

func (r *Runner) startCodexTurn(ctx context.Context, issue store.Issue, project store.Project) error {
	if err := r.codex.Start(ctx); err != nil {
		return err
	}
	r.ensureCodexEventPump()
	threadID, err := r.codex.ThreadStart(ctx, codex.ThreadInput{
		CWD: project.CWD, Model: project.Model, ApprovalPolicy: project.ApprovalPolicy,
		Sandbox: project.Sandbox, DeveloperInstructions: developerInstructions(),
		ThreadSource: codex.ThreadSourceSubagent,
	})
	if err != nil {
		return err
	}
	r.updateRuntime(ctx, issue.ID, threadID, "")
	r.setCodexThreadName(ctx, threadID, issue)
	eventsCh, unsubscribe := r.subscribeCodexEvents()
	defer unsubscribe()
	input, err := buildTurnInput(ctx, r.store, renderPrompt(project, issue))
	if err != nil {
		return err
	}
	turnID, err := r.codex.TurnStart(ctx, threadID, input, codex.TurnOptions{})
	if err != nil {
		return err
	}
	r.updateRuntime(ctx, issue.ID, threadID, turnID)
	return r.consumeEvents(ctx, issue.ID, threadID, turnID, eventsCh)
}

func (r *Runner) setCodexThreadName(ctx context.Context, threadID string, issue store.Issue) {
	if name := strings.TrimSpace(issue.Title); name != "" {
		_ = r.codex.ThreadSetName(ctx, threadID, name)
	}
}

func (r *Runner) consumeEvents(ctx context.Context, issueID int64, threadID, turnID string, eventsCh <-chan codex.Event) error {
	for {
		select {
		case <-ctx.Done():
			return nil
		case event := <-eventsCh:
			if !matches(event, threadID, turnID) {
				continue
			}
			if done, err := r.handleCodexEvent(ctx, issueID, event); done || err != nil {
				return err
			}
		}
	}
}

func (r *Runner) handleCodexEvent(ctx context.Context, issueID int64, event codex.Event) (bool, error) {
	if event.Text != "" {
		r.publishLog(ctx, issueID, event)
	}
	if isAgentError(event) && event.Error != "" {
		if r.issueAlreadyTerminal(ctx, issueID) {
			return true, nil
		}
		return true, eventError(event.Error)
	}
	if !isAgentTurnCompleted(event) {
		return false, nil
	}
	return true, r.finishIssueAfterTurn(ctx, issueID, event)
}

func isAgentError(event codex.Event) bool {
	return event.AgentEventType == events.AgentError || event.Method == "error"
}

func isAgentTurnCompleted(event codex.Event) bool {
	return event.AgentEventType == events.AgentTurnCompleted || event.Method == "turn/completed"
}

func (r *Runner) issueAlreadyTerminal(ctx context.Context, issueID int64) bool {
	current, err := r.store.GetIssue(ctx, issueID)
	return err == nil && isTerminalStatus(current.Status)
}

func (r *Runner) finishIssueAfterTurn(ctx context.Context, issueID int64, event codex.Event) error {
	current, err := r.store.GetIssue(ctx, issueID)
	if err != nil {
		return err
	}
	if isTerminalStatus(current.Status) {
		return nil
	}
	if event.Status == "completed" {
		r.failIssue(ctx, issueID, missingExplicitStatusMessage())
		return nil
	}
	if event.Error == "" {
		event.Error = "Codex turn ended with status: " + event.Status
	}
	if reason, ok := isRunnerHoldError(event.Error); ok {
		return runnerHoldError{reason: reason}
	}
	if isTransientCodexTransportError(event.Error) {
		return eventError(event.Error)
	}
	r.failIssue(ctx, issueID, event.Error)
	return nil
}

func isTerminalStatus(status string) bool {
	return status == store.StatusDone || status == store.StatusFailed || status == store.StatusCancelled
}

func missingExplicitStatusMessage() string {
	return "Codex turn completed without explicit issue status update; expected Codex to run codex-issue-runner issue update after verification"
}

func matches(event codex.Event, threadID, turnID string) bool {
	if event.ThreadID == "" {
		return false
	}
	if event.ThreadID != threadID {
		return false
	}
	return event.TurnID == "" || event.TurnID == turnID
}

type eventError string

func (e eventError) Error() string { return string(e) }

type runnerHoldError struct {
	reason holdReason
}

func (e runnerHoldError) Error() string { return e.reason.Message }

func (e runnerHoldError) Is(target error) bool {
	_, ok := target.(runnerHoldError)
	return ok
}

func (r *Runner) publishLog(ctx context.Context, issueID int64, event codex.Event) {
	payload, _ := json.Marshal(issueLogPayload(event))
	e, err := r.store.AddIssueEvent(ctx, issueID, "issue.log", string(payload))
	if err != nil {
		return
	}
	r.bus.Publish(events.AppEvent{
		ID: e.ID, Type: "issue.log", IssueID: issueID, Text: event.Text, Payload: e.Payload,
		AgentEventType: event.AgentEventType, Provider: event.Provider, RawMethod: rawMethod(event),
		RawPayload: event.RawPayload, Command: event.Command, Path: event.Path, Status: event.Status,
		Error: event.Error, CreatedAt: e.CreatedAt,
	})
}

func issueLogPayload(event codex.Event) events.AgentEventPayload {
	return events.AgentEventPayload{
		Type: event.AgentEventType, Provider: event.Provider, RawMethod: rawMethod(event),
		RawPayload: rawPayload(event), Text: event.Text, Command: event.Command, Path: event.Path,
		Status: event.Status, Error: event.Error,
	}
}

func rawMethod(event codex.Event) string {
	if event.RawMethod != "" {
		return event.RawMethod
	}
	return event.Method
}

func rawPayload(event codex.Event) json.RawMessage {
	if json.Valid([]byte(event.RawPayload)) {
		return json.RawMessage(event.RawPayload)
	}
	if json.Valid([]byte(event.Payload)) {
		return json.RawMessage(event.Payload)
	}
	if event.RawPayload == "" && event.Payload == "" {
		return nil
	}
	body, _ := json.Marshal(firstNonEmpty(event.RawPayload, event.Payload))
	return body
}

func renderPrompt(project store.Project, issue store.Issue) string {
	template := issue.PromptTemplate
	if strings.TrimSpace(template) == "" {
		template = store.DefaultIssuePromptTemplate
	}
	prompt := renderIssuePromptTemplate(template, project, issue)
	if strings.HasSuffix(prompt, "\n") {
		return prompt
	}
	return prompt + "\n"
}

func renderIssuePromptTemplate(template string, project store.Project, issue store.Issue) string {
	return strings.NewReplacer(
		"{{project.id}}", project.ID,
		"{{project.name}}", project.Name,
		"{{project.cwd}}", project.CWD,
		"{{issue.id}}", strconv.FormatInt(issue.ID, 10),
		"{{issue.title}}", issue.Title,
		"{{issue.content}}", issueContent(issue),
		"{{issue.description}}", strings.TrimSpace(issue.Description),
		"{{issue.priority}}", strconv.Itoa(issue.Priority),
	).Replace(template)
}

func issueContent(issue store.Issue) string {
	if text := strings.TrimSpace(issue.Description); text != "" {
		return text
	}
	return strings.TrimSpace(issue.Title)
}
