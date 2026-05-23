package runner

import (
	"context"
	"errors"
	"strings"

	"github.com/xiaobei/codex-issue-runner/backend/internal/codex"
	"github.com/xiaobei/codex-issue-runner/backend/internal/store"
)

type SessionCreateInput struct {
	ProjectID       string
	CWD             string
	Model           string
	ReasoningEffort string
	ApprovalPolicy  string
	Sandbox         string
	Prompt          string
}

type SessionCreateResult struct {
	ThreadID string `json:"thread_id"`
	TurnID   string `json:"turn_id,omitempty"`
}

type SessionTurnInput struct {
	Prompt          string
	Model           string
	ReasoningEffort string
	ApprovalPolicy  string
	Sandbox         string
}

func (r *Runner) ListModels(ctx context.Context) (codex.ModelListResult, error) {
	if err := r.prepareCodex(ctx); err != nil {
		return codex.ModelListResult{}, err
	}
	return r.codex.ModelList(ctx, codex.ModelListInput{})
}

func (r *Runner) ResolveApproval(ctx context.Context, requestID string, decision codex.ApprovalDecision) error {
	return r.codex.ResolveApproval(ctx, requestID, decision)
}

func (r *Runner) ListSessions(ctx context.Context, input codex.SessionListInput) (codex.SessionListResult, error) {
	if err := r.prepareCodex(ctx); err != nil {
		return codex.SessionListResult{}, err
	}
	res, err := r.codex.ThreadList(ctx, input)
	if err != nil {
		return codex.SessionListResult{}, err
	}
	r.applyRunningSessionState(res.Data)
	if err := r.applySessionOrigin(ctx, res.Data); err != nil {
		return codex.SessionListResult{}, err
	}
	return res, nil
}

func (r *Runner) ReadSession(ctx context.Context, threadID string) (codex.Session, error) {
	if err := r.prepareCodex(ctx); err != nil {
		return codex.Session{}, err
	}
	res, err := r.codex.ThreadResume(ctx, threadID)
	if err != nil {
		return codex.Session{}, err
	}
	if r.isThreadRunning(sessionThreadID(res, threadID)) || codex.SessionStatusIsRunning(res.Status) {
		res.IsRunning = true
	}
	sessions := []codex.Session{res}
	if err := r.applySessionOrigin(ctx, sessions); err != nil {
		return codex.Session{}, err
	}
	res = sessions[0]
	return res, nil
}

func (r *Runner) CreateSession(ctx context.Context, input SessionCreateInput) (SessionCreateResult, error) {
	threadInput, err := r.threadInputForSession(ctx, input)
	if err != nil {
		return SessionCreateResult{}, err
	}
	if err := r.prepareCodex(ctx); err != nil {
		return SessionCreateResult{}, err
	}
	threadID, err := r.codex.ThreadStart(ctx, threadInput)
	if err != nil {
		return SessionCreateResult{}, err
	}
	return r.startInitialTurn(ctx, threadID, input)
}

func (r *Runner) StartSessionTurn(ctx context.Context, threadID string, input SessionTurnInput) (string, error) {
	if strings.TrimSpace(input.Prompt) == "" {
		return "", errors.New("消息内容不能为空")
	}
	if err := r.prepareCodex(ctx); err != nil {
		return "", err
	}
	if _, err := r.codex.ThreadResume(ctx, threadID); err != nil {
		return "", err
	}
	return r.startSessionTurnWithOptions(ctx, threadID, input.Prompt, sessionTurnOptions(input))
}

func (r *Runner) InterruptSession(threadID string) bool {
	r.mu.Lock()
	state := r.sessions[threadID]
	r.mu.Unlock()
	if state == nil || state.turnID == "" {
		return false
	}
	go r.codex.InterruptTurn(context.Background(), threadID, state.turnID)
	return true
}

func (r *Runner) prepareCodex(ctx context.Context) error {
	if err := r.codex.Start(ctx); err != nil {
		return err
	}
	r.ensureCodexEventPump()
	return nil
}

func (r *Runner) threadInputForSession(ctx context.Context, input SessionCreateInput) (codex.ThreadInput, error) {
	project, err := r.sessionProject(ctx, input.ProjectID)
	if err != nil {
		return codex.ThreadInput{}, err
	}
	return mergeSessionThreadInput(project, input)
}

func (r *Runner) sessionProject(ctx context.Context, id string) (*store.Project, error) {
	if id == "" {
		return nil, nil
	}
	project, err := r.store.GetProject(ctx, id)
	if err != nil {
		return nil, err
	}
	return &project, nil
}

func mergeSessionThreadInput(project *store.Project, input SessionCreateInput) (codex.ThreadInput, error) {
	threadInput := codex.ThreadInput{
		CWD: input.CWD, Model: input.Model, ReasoningEffort: input.ReasoningEffort,
		ApprovalPolicy: input.ApprovalPolicy, Sandbox: input.Sandbox,
	}
	if project != nil {
		threadInput = codex.ThreadInput{CWD: project.CWD, Model: project.Model, ApprovalPolicy: project.ApprovalPolicy, Sandbox: project.Sandbox}
	}
	applySessionOverrides(&threadInput, input)
	if strings.TrimSpace(threadInput.CWD) == "" {
		return codex.ThreadInput{}, errors.New("cwd 不能为空")
	}
	return threadInput, nil
}

func applySessionOverrides(target *codex.ThreadInput, input SessionCreateInput) {
	if input.CWD != "" {
		target.CWD = input.CWD
	}
	if input.Model != "" {
		target.Model = input.Model
	}
	if input.ReasoningEffort != "" {
		target.ReasoningEffort = input.ReasoningEffort
	}
	if input.ApprovalPolicy != "" {
		target.ApprovalPolicy = input.ApprovalPolicy
	}
	if input.Sandbox != "" {
		target.Sandbox = input.Sandbox
	}
	target.DeveloperInstructions = developerInstructions()
	target.ThreadSource = codex.ThreadSourceUser
}

func (r *Runner) startInitialTurn(ctx context.Context, threadID string, input SessionCreateInput) (SessionCreateResult, error) {
	result := SessionCreateResult{ThreadID: threadID}
	if strings.TrimSpace(input.Prompt) == "" {
		return result, nil
	}
	turnID, err := r.startSessionTurnWithOptions(ctx, threadID, input.Prompt, sessionCreateTurnOptions(input))
	if err != nil {
		return SessionCreateResult{}, err
	}
	result.TurnID = turnID
	return result, nil
}

func (r *Runner) startSessionTurnWithOptions(ctx context.Context, threadID, prompt string, options codex.TurnOptions) (string, error) {
	eventsCh, unsubscribe := r.subscribeCodexEvents()
	input, err := buildTurnInput(ctx, r.store, prompt)
	if err != nil {
		unsubscribe()
		return "", err
	}
	turnID, err := r.codex.TurnStart(ctx, threadID, input, options)
	if err != nil {
		unsubscribe()
		return "", err
	}
	r.setSessionRunning(threadID, turnID)
	go r.waitSessionTurn(threadID, turnID, eventsCh, unsubscribe)
	return turnID, nil
}

func sessionCreateTurnOptions(input SessionCreateInput) codex.TurnOptions {
	return turnOptionsFromFields(input.Model, input.ReasoningEffort, input.ApprovalPolicy, input.Sandbox)
}

func sessionTurnOptions(input SessionTurnInput) codex.TurnOptions {
	return turnOptionsFromFields(input.Model, input.ReasoningEffort, input.ApprovalPolicy, input.Sandbox)
}

func turnOptionsFromFields(model, reasoningEffort, approvalPolicy, sandbox string) codex.TurnOptions {
	return codex.TurnOptions{
		Model: model, ReasoningEffort: reasoningEffort,
		ApprovalPolicy: approvalPolicy, Sandbox: sandbox,
	}
}

func (r *Runner) setSessionRunning(threadID, turnID string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.sessions[threadID] = &runState{threadID: threadID, turnID: turnID}
}

func (r *Runner) clearSessionRunning(threadID, turnID string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if state := r.sessions[threadID]; state != nil && state.turnID == turnID {
		delete(r.sessions, threadID)
	}
}

func (r *Runner) waitSessionTurn(threadID, turnID string, eventsCh <-chan codex.Event, unsubscribe func()) {
	defer unsubscribe()
	for event := range eventsCh {
		if !matches(event, threadID, turnID) {
			continue
		}
		if isAgentTurnCompleted(event) || isAgentError(event) {
			r.clearSessionRunning(threadID, turnID)
			return
		}
	}
}

func (r *Runner) applyRunningSessionState(sessions []codex.Session) {
	runningIDs := r.runningThreadIDs()
	for i := range sessions {
		if sessions[i].IsRunning || codex.SessionStatusIsRunning(sessions[i].Status) {
			sessions[i].IsRunning = true
			continue
		}
		if runningIDs[sessions[i].ID] {
			sessions[i].IsRunning = true
		}
	}
}

func (r *Runner) applySessionOrigin(ctx context.Context, sessions []codex.Session) error {
	issueThreadIDs, err := r.store.ListIssueThreadIDs(ctx)
	if err != nil {
		return err
	}
	knownRunnerThreadIDs := r.runningThreadIDs()
	for i := range sessions {
		if isRunnerSession(sessions[i], issueThreadIDs, knownRunnerThreadIDs) {
			sessions[i].Origin = codex.SessionOriginRunner
		} else {
			sessions[i].Origin = codex.SessionOriginCodexApp
		}
	}
	return nil
}

func isRunnerSession(session codex.Session, issueThreadIDs, knownRunnerThreadIDs map[string]bool) bool {
	if knownRunnerThreadIDs[session.ID] {
		return true
	}
	if issueThreadIDs[session.ID] {
		return true
	}
	if isRunnerSource(session.Source) {
		return true
	}
	if session.ThreadSource != nil && isRunnerSource(*session.ThreadSource) {
		return true
	}
	return false
}

func isRunnerSource(source string) bool {
	source = strings.ToLower(strings.TrimSpace(source))
	return strings.HasPrefix(source, "codex-issue-runner")
}

func (r *Runner) isThreadRunning(threadID string) bool {
	if threadID == "" {
		return false
	}
	return r.runningThreadIDs()[threadID]
}

func (r *Runner) runningThreadIDs() map[string]bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	ids := map[string]bool{}
	for threadID := range r.sessions {
		if threadID != "" {
			ids[threadID] = true
		}
	}
	for _, state := range r.running {
		if state != nil && state.threadID != "" {
			ids[state.threadID] = true
		}
	}
	return ids
}

func sessionThreadID(session codex.Session, fallback string) string {
	if session.ID != "" {
		return session.ID
	}
	return fallback
}
