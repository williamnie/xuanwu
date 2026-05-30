package runner

import (
	"context"
	"encoding/json"
	"errors"
	"strconv"
	"strings"
	"time"

	"github.com/xiaobei/codex-issue-runner/backend/internal/agent"
	"github.com/xiaobei/codex-issue-runner/backend/internal/events"
	"github.com/xiaobei/codex-issue-runner/backend/internal/store"
)

const issueActiveCheckInterval = 200 * time.Millisecond

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
	selection, err := r.buildRunSelection(ctx, issue, project)
	if err != nil {
		r.failIssue(ctx, issue.ID, err.Error())
		return
	}
	if err := r.EnsureCleanWorktree(ctx, project.CWD); err != nil {
		if reason, ok := dirtyWorktreeHoldReason(err); ok {
			r.holdIssue(ctx, issue, reason)
			return
		}
		r.failIssue(ctx, issue.ID, err.Error())
		return
	}
	if err := r.persistRunSelection(ctx, issue.ID, selection); err != nil {
		r.failIssue(ctx, issue.ID, err.Error())
		return
	}
	r.recordRunSelectionEvent(ctx, issue.ID, selection)
	if err := r.validateRunSelection(project.ID, selection); err != nil {
		r.failIssue(ctx, issue.ID, err.Error())
		return
	}
	if err := r.startIssueRun(ctx, issue, project, selection); err != nil {
		var holdErr runnerHoldError
		if errors.As(err, &holdErr) {
			r.holdIssue(ctx, issue, holdErr.reason)
			return
		}
		if reason, ok := isRunnerHoldError(err.Error()); ok {
			r.holdIssue(ctx, issue, reason)
			return
		}
		r.failIssue(ctx, issue.ID, err.Error())
	}
}

func (r *Runner) startIssueRun(
	ctx context.Context,
	issue store.Issue,
	project store.Project,
	selection RunSelection,
) error {
	if err := r.applyRunSelection(ctx, issue.ID, &project, selection); err != nil {
		return err
	}
	provider, ok := r.providerByID(selection.ProviderID)
	if !ok {
		return providerMismatchError(project, r.providerID())
	}
	if issueRunner, ok := provider.(agent.IssueRunner); ok {
		return r.runProviderIssue(ctx, provider, issueRunner, issue, project)
	}
	return r.startCodexTurn(ctx, issue, project)
}

func applyAgentProfileExecutionPreset(project *store.Project, profile store.AgentProfile) {
	if strings.TrimSpace(profile.Model) != "" {
		project.Model = profile.Model
	}
	if strings.TrimSpace(profile.ApprovalPolicy) != "" {
		project.ApprovalPolicy = profile.ApprovalPolicy
	}
	if strings.TrimSpace(profile.Sandbox) != "" {
		project.Sandbox = profile.Sandbox
	}
}

func profileReasoningEffort(profile *store.AgentProfile) string {
	if profile == nil {
		return ""
	}
	return strings.TrimSpace(profile.ReasoningEffort)
}

func (r *Runner) runProviderIssue(
	ctx context.Context,
	providerAgent agent.AgentProvider,
	provider agent.IssueRunner,
	issue store.Issue,
	project store.Project,
) error {
	providerID := providerKey(providerAgent.Name())
	result, err := provider.RunIssue(ctx, agent.IssueRunInput{
		IssueID:         issue.ID,
		ProjectID:       project.ID,
		CWD:             project.CWD,
		Prompt:          renderPrompt(project, issue),
		Model:           project.Model,
		ReasoningEffort: profileReasoningEffort(project.DefaultAgentProfile),
		ApprovalPolicy:  project.ApprovalPolicy,
		Sandbox:         project.Sandbox,
		Log: func(event agent.Event) {
			r.publishLog(ctx, issue.ID, event)
			if event.ThreadID != "" || event.TurnID != "" {
				r.updateProviderRuntime(ctx, issue.ID, providerID, event.ThreadID, event.TurnID)
			}
		},
	})
	if err != nil {
		return err
	}
	r.updateProviderRuntime(ctx, issue.ID, providerID, result.ProviderSessionID, result.ProviderTurnID)
	return r.finishIssueAfterProviderRun(ctx, issue.ID, providerID)
}

func (r *Runner) finishIssueAfterProviderRun(ctx context.Context, issueID int64, providerID string) error {
	current, err := r.store.GetIssue(ctx, issueID)
	if err != nil {
		return err
	}
	if isTerminalStatus(current.Status) {
		r.advanceNightlyBatches(ctx, issueID)
		return nil
	}
	r.failIssue(ctx, issueID, missingProviderExplicitStatusMessage(providerID))
	return nil
}

func (r *Runner) startCodexTurn(ctx context.Context, issue store.Issue, project store.Project) error {
	if err := r.agent.Start(ctx); err != nil {
		return err
	}
	r.ensureCodexEventPump()
	threadID, err := r.prepareIssueThread(ctx, issue, project)
	if err != nil {
		return err
	}
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

func (r *Runner) prepareIssueThread(ctx context.Context, issue store.Issue, project store.Project) (string, error) {
	if threadID := retryThreadID(issue); threadID != "" {
		r.updateRuntime(ctx, issue.ID, threadID, "")
		return threadID, nil
	}
	threadID, err := r.startThread(ctx, agent.ThreadInput{
		CWD: project.CWD, Model: project.Model,
		ReasoningEffort: profileReasoningEffort(project.DefaultAgentProfile),
		ApprovalPolicy:  project.ApprovalPolicy, Sandbox: project.Sandbox,
		DeveloperInstructions: developerInstructions(),
		ThreadSource:          agent.ThreadSourceSubagent,
	})
	if err != nil {
		return "", err
	}
	r.updateRuntime(ctx, issue.ID, threadID, "")
	r.setCodexThreadName(ctx, threadID, issue)
	return threadID, nil
}

func retryThreadID(issue store.Issue) string {
	if issue.AttemptCount <= 1 {
		return ""
	}
	return strings.TrimSpace(issue.CodexThreadID)
}

func (r *Runner) setCodexThreadName(ctx context.Context, threadID string, issue store.Issue) {
	if name := strings.TrimSpace(issue.Title); name != "" {
		_ = r.setThreadName(ctx, threadID, name)
	}
}

func (r *Runner) consumeEvents(ctx context.Context, issueID int64, threadID, turnID string, eventsCh <-chan agent.Event) error {
	checkActive := time.NewTicker(issueActiveCheckInterval)
	defer checkActive.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-checkActive.C:
			if active, err := r.issueRunStillActive(ctx, issueID, threadID, turnID); err != nil || !active {
				return err
			}
		case event := <-eventsCh:
			if !matches(event, threadID, turnID) {
				continue
			}
			if active, err := r.issueRunStillActive(ctx, issueID, threadID, turnID); err != nil || !active {
				return err
			}
			if done, err := r.handleCodexEvent(ctx, issueID, event); done || err != nil {
				return err
			}
		}
	}
}

func (r *Runner) issueRunStillActive(ctx context.Context, issueID int64, threadID, turnID string) (bool, error) {
	current, err := r.store.GetIssue(ctx, issueID)
	if err != nil {
		return false, err
	}
	if current.Status != store.StatusInProgress || current.CodexThreadID != threadID || current.CodexTurnID != turnID {
		if isTerminalStatus(current.Status) {
			r.advanceNightlyBatches(ctx, issueID)
		}
		return false, nil
	}
	runs, err := r.store.ListIssueRuns(ctx, issueID)
	if err != nil {
		return false, err
	}
	if len(runs) == 0 || runs[len(runs)-1].EndedAt != "" || runs[len(runs)-1].Status != store.StatusInProgress {
		return false, nil
	}
	return true, nil
}

func (r *Runner) handleCodexEvent(ctx context.Context, issueID int64, event agent.Event) (bool, error) {
	if event.Text != "" || event.Error != "" {
		r.publishLog(ctx, issueID, event)
	}
	if isAgentError(event) && event.Error != "" {
		if isCodexReconnectProgressError(event.Error) {
			return false, nil
		}
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

func isCodexReconnectProgressError(message string) bool {
	lower := strings.ToLower(strings.TrimSpace(message))
	if !strings.HasPrefix(lower, "reconnecting...") || !strings.Contains(lower, "/5") {
		return false
	}
	return strings.Contains(lower, "stream disconnected before completion") ||
		strings.Contains(lower, "upstream request failed") ||
		strings.Contains(lower, "transport error")
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
		r.advanceNightlyBatches(ctx, issueID)
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
	return status == store.StatusDone || status == store.StatusFailed ||
		status == store.StatusCancelled || status == store.StatusPendingVerification
}

func missingExplicitStatusMessage() string {
	return "Codex turn completed without explicit issue status update; expected Codex to run codex-issue-runner issue update after verification"
}

func missingProviderExplicitStatusMessage(provider string) string {
	provider = strings.TrimSpace(provider)
	if provider == "" {
		provider = "provider"
	}
	return provider + " run completed without explicit issue status update; expected provider to run codex-issue-runner issue update or the documented HTTP equivalent after verification"
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
		RawPayload: rawPayload(event), Payload: eventPayload(event), Text: event.Text,
		Command: event.Command, Path: event.Path, Status: event.Status, Error: event.Error,
	}
}

func rawMethod(event agent.Event) string {
	if event.ProviderMethod() != "" {
		return event.ProviderMethod()
	}
	return event.Method
}

func rawPayload(event agent.Event) json.RawMessage {
	payload := event.ProviderPayload()
	if payload == "" {
		return nil
	}
	if json.Valid([]byte(payload)) {
		return json.RawMessage(payload)
	}
	body, _ := json.Marshal(payload)
	return body
}

func eventPayload(event agent.Event) json.RawMessage {
	if event.Payload == "" {
		return nil
	}
	if json.Valid([]byte(event.Payload)) {
		return json.RawMessage(event.Payload)
	}
	body, _ := json.Marshal(event.Payload)
	return body
}

func renderPrompt(project store.Project, issue store.Issue) string {
	template := issue.PromptTemplate
	if strings.TrimSpace(template) == "" {
		template = store.DefaultIssuePromptTemplate
	}
	prompt := renderIssuePromptTemplate(template, project, issue)
	profile := project.DefaultAgentProfile
	if profile == nil && strings.TrimSpace(project.DefaultAgentProfileID) != "" {
		profile = projectProfileFromFields(project)
	}
	prompt = appendAgentProfileSummary(prompt, profile)
	prompt = appendVerificationGatePrompt(prompt, issue, VerificationGateEnabled(project))
	if strings.HasSuffix(prompt, "\n") {
		return prompt
	}
	return prompt + "\n"
}

func projectProfileFromFields(project store.Project) *store.AgentProfile {
	return &store.AgentProfile{
		ID: project.DefaultAgentProfileID, Name: project.DefaultAgentProfileID,
		Provider: project.Provider, Model: project.Model,
		ApprovalPolicy: project.ApprovalPolicy, Sandbox: project.Sandbox,
	}
}

func appendAgentProfileSummary(prompt string, profile *store.AgentProfile) string {
	if profile == nil || strings.TrimSpace(profile.ID) == "" {
		return prompt
	}
	lines := []string{
		"", "Agent Profile v0（项目默认执行画像）:",
		"- Profile: " + profile.ID + " · " + profile.Name,
		"- Provider: " + firstNonEmpty(profile.Provider, store.ProviderCodex),
		"- Model: " + firstNonEmpty(profile.Model, "project default") +
			" · Effort: " + firstNonEmpty(profile.ReasoningEffort, "provider default") +
			" · Approval: " + firstNonEmpty(profile.ApprovalPolicy, "current project policy") +
			" · Sandbox: " + firstNonEmpty(profile.Sandbox, "current project sandbox"),
	}
	if instructions := strings.TrimSpace(profile.DefaultInstructions); instructions != "" {
		lines = append(lines, "- Default instructions: "+instructions)
	}
	lines = appendIntentLine(lines, "Skills", profile.SkillIntents)
	lines = appendIntentLine(lines, "Plugins", profile.PluginIntents)
	lines = append(lines,
		"- 这些 skill/plugin intents 只是请求使用/上下文，不会安装插件、授权工具或绕过当前 provider 权限策略。")
	return strings.TrimRight(prompt, "\n") + "\n" + strings.Join(lines, "\n") + "\n"
}

func appendIntentLine(lines []string, label string, raw string) []string {
	items := parseIntentList(raw)
	if len(items) == 0 {
		return lines
	}
	return append(lines, "- "+label+" requested as context/intents only: "+strings.Join(items, ", "))
}

func parseIntentList(raw string) []string {
	var values []string
	if json.Unmarshal([]byte(strings.TrimSpace(raw)), &values) == nil {
		return cleanIntentList(values)
	}
	parts := strings.Split(raw, ",")
	return cleanIntentList(parts)
}

func cleanIntentList(values []string) []string {
	out := []string{}
	seen := map[string]bool{}
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" || seen[value] {
			continue
		}
		seen[value] = true
		out = append(out, value)
	}
	return out
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
