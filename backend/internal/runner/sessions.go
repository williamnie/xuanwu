package runner

import (
	"context"
	"errors"
	"strings"

	"github.com/xiaobei/codex-issue-runner/backend/internal/agent"
	"github.com/xiaobei/codex-issue-runner/backend/internal/events"
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
	ID                string `json:"id"`
	Provider          string `json:"provider"`
	ProviderSessionID string `json:"provider_session_id"`
	ProviderTurnID    string `json:"provider_turn_id,omitempty"`
	ThreadID          string `json:"thread_id"`
	TurnID            string `json:"turn_id,omitempty"`
}

type SessionTurnInput struct {
	Prompt          string
	Model           string
	ReasoningEffort string
	ApprovalPolicy  string
	Sandbox         string
}

func (r *Runner) ListModels(ctx context.Context) (agent.ModelListResult, error) {
	if err := r.prepareCodex(ctx); err != nil {
		return agent.ModelListResult{}, err
	}
	return r.listModels(ctx)
}

func (r *Runner) ResolveApproval(ctx context.Context, requestID string, decision agent.ApprovalDecision) error {
	return r.resolveApproval(ctx, requestID, decision)
}

func (r *Runner) ListSessions(ctx context.Context, input agent.SessionListInput) (agent.SessionListResult, error) {
	if err := r.prepareCodex(ctx); err != nil {
		return agent.SessionListResult{}, err
	}
	res, err := r.listThreads(ctx, input)
	if err != nil {
		return agent.SessionListResult{}, err
	}
	r.applyRunningSessionState(res.Data)
	if err := r.applySessionOrigin(ctx, res.Data); err != nil {
		return agent.SessionListResult{}, err
	}
	applyCodexSessionIdentity(res.Data)
	return res, nil
}

func (r *Runner) ReadSession(ctx context.Context, threadID string) (agent.Session, error) {
	if err := r.prepareCodex(ctx); err != nil {
		return agent.Session{}, err
	}
	res, err := r.resumeThread(ctx, threadID)
	if err != nil {
		return agent.Session{}, err
	}
	if r.isThreadRunning(sessionThreadID(res, threadID)) || agent.SessionStatusIsRunning(res.Status) {
		res.IsRunning = true
	}
	sessions := []agent.Session{res}
	if err := r.applySessionOrigin(ctx, sessions); err != nil {
		return agent.Session{}, err
	}
	applyCodexSessionIdentity(sessions)
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
	threadID, err := r.agent.StartThread(ctx, threadInput)
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
	if _, err := r.resumeThread(ctx, threadID); err != nil {
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
	go r.interruptTurn(context.Background(), threadID, state.turnID)
	return true
}

func (r *Runner) prepareCodex(ctx context.Context) error {
	if err := r.agent.Start(ctx); err != nil {
		return err
	}
	r.ensureCodexEventPump()
	return nil
}

func (r *Runner) threadInputForSession(ctx context.Context, input SessionCreateInput) (agent.ThreadInput, error) {
	project, err := r.sessionProject(ctx, input.ProjectID)
	if err != nil {
		return agent.ThreadInput{}, err
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
	if err := ensureCodexProjectProvider(project); err != nil {
		return nil, err
	}
	return &project, nil
}

func mergeSessionThreadInput(project *store.Project, input SessionCreateInput) (agent.ThreadInput, error) {
	threadInput := agent.ThreadInput{
		CWD: input.CWD, Model: input.Model, ReasoningEffort: input.ReasoningEffort,
		ApprovalPolicy: input.ApprovalPolicy, Sandbox: input.Sandbox,
	}
	if project != nil {
		threadInput = agent.ThreadInput{CWD: project.CWD, Model: project.Model, ApprovalPolicy: project.ApprovalPolicy, Sandbox: project.Sandbox}
	}
	applySessionOverrides(&threadInput, input)
	if strings.TrimSpace(threadInput.CWD) == "" {
		return agent.ThreadInput{}, errors.New("cwd 不能为空")
	}
	return threadInput, nil
}

func applySessionOverrides(target *agent.ThreadInput, input SessionCreateInput) {
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
	target.ThreadSource = agent.ThreadSourceUser
}

func (r *Runner) startInitialTurn(ctx context.Context, threadID string, input SessionCreateInput) (SessionCreateResult, error) {
	result := newCodexSessionCreateResult(threadID)
	if strings.TrimSpace(input.Prompt) == "" {
		return result, nil
	}
	turnID, err := r.startSessionTurnWithOptions(ctx, threadID, input.Prompt, sessionCreateTurnOptions(input))
	if err != nil {
		return SessionCreateResult{}, err
	}
	result.TurnID = turnID
	result.ProviderTurnID = turnID
	return result, nil
}

func (r *Runner) startSessionTurnWithOptions(ctx context.Context, threadID, prompt string, options agent.TurnOptions) (string, error) {
	eventsCh, unsubscribe := r.subscribeCodexEvents()
	input, err := buildTurnInput(ctx, r.store, prompt)
	if err != nil {
		unsubscribe()
		return "", err
	}
	turnID, err := r.agent.StartTurn(ctx, threadID, input, options)
	if err != nil {
		unsubscribe()
		return "", err
	}
	r.setSessionRunning(threadID, turnID)
	go r.waitSessionTurn(threadID, turnID, eventsCh, unsubscribe)
	return turnID, nil
}

func sessionCreateTurnOptions(input SessionCreateInput) agent.TurnOptions {
	return turnOptionsFromFields(input.Model, input.ReasoningEffort, input.ApprovalPolicy, input.Sandbox)
}

func sessionTurnOptions(input SessionTurnInput) agent.TurnOptions {
	return turnOptionsFromFields(input.Model, input.ReasoningEffort, input.ApprovalPolicy, input.Sandbox)
}

func turnOptionsFromFields(model, reasoningEffort, approvalPolicy, sandbox string) agent.TurnOptions {
	return agent.TurnOptions{
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

func (r *Runner) waitSessionTurn(threadID, turnID string, eventsCh <-chan agent.Event, unsubscribe func()) {
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

func (r *Runner) applyRunningSessionState(sessions []agent.Session) {
	runningIDs := r.runningThreadIDs()
	for i := range sessions {
		if sessions[i].IsRunning || agent.SessionStatusIsRunning(sessions[i].Status) {
			sessions[i].IsRunning = true
			continue
		}
		if runningIDs[sessions[i].ID] {
			sessions[i].IsRunning = true
		}
	}
}

func (r *Runner) applySessionOrigin(ctx context.Context, sessions []agent.Session) error {
	issueThreadIDs, err := r.store.ListIssueThreadIDs(ctx)
	if err != nil {
		return err
	}
	knownRunnerThreadIDs := r.runningThreadIDs()
	for i := range sessions {
		if isRunnerSession(sessions[i], issueThreadIDs, knownRunnerThreadIDs) {
			sessions[i].Origin = agent.SessionOriginRunner
		} else {
			sessions[i].Origin = agent.SessionOriginCodexApp
		}
	}
	return nil
}

func isRunnerSession(session agent.Session, issueThreadIDs, knownRunnerThreadIDs map[string]bool) bool {
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

func sessionThreadID(session agent.Session, fallback string) string {
	if session.ID != "" {
		return session.ID
	}
	return fallback
}

func applyCodexSessionIdentity(sessions []agent.Session) {
	for i := range sessions {
		rawID := sessionThreadID(sessions[i], sessions[i].SessionID)
		if rawID == "" {
			continue
		}
		sessions[i].Provider = events.ProviderCodex
		sessions[i].ProviderSessionID = rawID
		if sessions[i].SessionID == "" {
			sessions[i].SessionID = rawID
		}
		sessions[i].ID = providerSessionKey(events.ProviderCodex, rawID)
	}
}

func newCodexSessionCreateResult(threadID string) SessionCreateResult {
	return SessionCreateResult{
		ID:                providerSessionKey(events.ProviderCodex, threadID),
		Provider:          events.ProviderCodex,
		ProviderSessionID: threadID,
		ThreadID:          threadID,
	}
}

func providerSessionKey(provider, sessionID string) string {
	provider = strings.TrimSpace(provider)
	sessionID = strings.TrimSpace(sessionID)
	if provider == "" || sessionID == "" {
		return sessionID
	}
	return provider + ":" + sessionID
}
