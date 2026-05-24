package runner

import (
	"context"
	"encoding/json"
	"errors"
	"strconv"
	"strings"

	"github.com/xiaobei/codex-issue-runner/backend/internal/agent"
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
	if err := r.ensureRunnableProjectProvider(project); err != nil {
		r.failIssue(ctx, issue.ID, err.Error())
		return
	}
	if err := r.startIssueRun(ctx, issue, project); err != nil {
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

func (r *Runner) startIssueRun(ctx context.Context, issue store.Issue, project store.Project) error {
	if issueRunner, ok := r.agent.(agent.IssueRunner); ok {
		return r.runProviderIssue(ctx, issueRunner, issue, project)
	}
	return r.startCodexTurn(ctx, issue, project)
}

func (r *Runner) runProviderIssue(
	ctx context.Context,
	provider agent.IssueRunner,
	issue store.Issue,
	project store.Project,
) error {
	result, err := provider.RunIssue(ctx, agent.IssueRunInput{
		IssueID:   issue.ID,
		ProjectID: project.ID,
		CWD:       project.CWD,
		Prompt:    renderPrompt(project, issue),
		Model:     project.Model,
		Log: func(event agent.Event) {
			r.publishLog(ctx, issue.ID, event)
		},
	})
	if err != nil {
		return err
	}
	r.updateRuntime(ctx, issue.ID, result.ProviderSessionID, result.ProviderTurnID)
	return r.finishIssueAfterProviderRun(ctx, issue.ID)
}

func (r *Runner) finishIssueAfterProviderRun(ctx context.Context, issueID int64) error {
	current, err := r.store.GetIssue(ctx, issueID)
	if err != nil {
		return err
	}
	if isTerminalStatus(current.Status) {
		return nil
	}
	r.failIssue(ctx, issueID, missingExplicitStatusMessage())
	return nil
}

func (r *Runner) startCodexTurn(ctx context.Context, issue store.Issue, project store.Project) error {
	if err := r.agent.Start(ctx); err != nil {
		return err
	}
	r.ensureCodexEventPump()
	threadID, err := r.startThread(ctx, agent.ThreadInput{
		CWD: project.CWD, Model: project.Model, ApprovalPolicy: project.ApprovalPolicy,
		Sandbox: project.Sandbox, DeveloperInstructions: developerInstructions(),
		ThreadSource: agent.ThreadSourceSubagent,
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
	turnID, err := r.startTurn(ctx, threadID, input, agent.TurnOptions{})
	if err != nil {
		return err
	}
	r.updateRuntime(ctx, issue.ID, threadID, turnID)
	return r.consumeEvents(ctx, issue.ID, threadID, turnID, eventsCh)
}

func (r *Runner) setCodexThreadName(ctx context.Context, threadID string, issue store.Issue) {
	if name := strings.TrimSpace(issue.Title); name != "" {
		_ = r.setThreadName(ctx, threadID, name)
	}
}

func (r *Runner) consumeEvents(ctx context.Context, issueID int64, threadID, turnID string, eventsCh <-chan agent.Event) error {
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

func (r *Runner) handleCodexEvent(ctx context.Context, issueID int64, event agent.Event) (bool, error) {
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

func isAgentError(event agent.Event) bool {
	return event.NormalizedType() == events.AgentError || event.Method == "error"
}

func isAgentTurnCompleted(event agent.Event) bool {
	return event.NormalizedType() == events.AgentTurnCompleted || event.Method == "turn/completed"
}

func (r *Runner) issueAlreadyTerminal(ctx context.Context, issueID int64) bool {
	current, err := r.store.GetIssue(ctx, issueID)
	return err == nil && isTerminalStatus(current.Status)
}

func (r *Runner) finishIssueAfterTurn(ctx context.Context, issueID int64, event agent.Event) error {
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

func matches(event agent.Event, threadID, turnID string) bool {
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

func (r *Runner) publishLog(ctx context.Context, issueID int64, event agent.Event) {
	payload, _ := json.Marshal(issueLogPayload(event))
	e, err := r.store.AddIssueEvent(ctx, issueID, "issue.log", string(payload))
	if err != nil {
		return
	}
	r.bus.Publish(events.AppEvent{
		ID: e.ID, Type: "issue.log", IssueID: issueID, Text: event.Text, Payload: e.Payload,
		AgentEventType: event.NormalizedType(), Provider: event.Provider, RawMethod: rawMethod(event),
		RawPayload: event.ProviderPayload(), Command: event.Command, Path: event.Path, Status: event.Status,
		Error: event.Error, CreatedAt: e.CreatedAt,
	})
}

func issueLogPayload(event agent.Event) events.AgentEventPayload {
	return events.AgentEventPayload{
		Type: event.NormalizedType(), Provider: event.Provider, RawMethod: rawMethod(event),
		RawPayload: rawPayload(event), Text: event.Text, Command: event.Command, Path: event.Path,
		Status: event.Status, Error: event.Error,
	}
}

func rawMethod(event agent.Event) string {
	if event.ProviderMethod() != "" {
		return event.ProviderMethod()
	}
	return event.Method
}

func rawPayload(event agent.Event) json.RawMessage {
	if json.Valid([]byte(event.ProviderPayload())) {
		return json.RawMessage(event.ProviderPayload())
	}
	if json.Valid([]byte(event.Payload)) {
		return json.RawMessage(event.Payload)
	}
	if event.ProviderPayload() == "" && event.Payload == "" {
		return nil
	}
	body, _ := json.Marshal(firstNonEmpty(event.ProviderPayload(), event.Payload))
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
