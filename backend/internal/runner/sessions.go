package runner

import (
	"context"
	"errors"
	"strings"

	"github.com/xiaobei/codex-issue-runner/backend/internal/codex"
	"github.com/xiaobei/codex-issue-runner/backend/internal/store"
)

type SessionCreateInput struct {
	ProjectID      string
	CWD            string
	Model          string
	ApprovalPolicy string
	Sandbox        string
	Prompt         string
}

type SessionCreateResult struct {
	ThreadID string `json:"thread_id"`
	TurnID   string `json:"turn_id,omitempty"`
}

func (r *Runner) ListSessions(ctx context.Context, input codex.SessionListInput) (codex.SessionListResult, error) {
	if err := r.prepareCodex(ctx); err != nil {
		return codex.SessionListResult{}, err
	}
	return r.codex.ThreadList(ctx, input)
}

func (r *Runner) ReadSession(ctx context.Context, threadID string) (codex.Session, error) {
	if err := r.prepareCodex(ctx); err != nil {
		return codex.Session{}, err
	}
	return r.codex.ThreadResume(ctx, threadID)
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
	return r.startInitialTurn(ctx, threadID, input.Prompt)
}

func (r *Runner) StartSessionTurn(ctx context.Context, threadID, prompt string) (string, error) {
	if strings.TrimSpace(prompt) == "" {
		return "", errors.New("消息内容不能为空")
	}
	if err := r.prepareCodex(ctx); err != nil {
		return "", err
	}
	if _, err := r.codex.ThreadResume(ctx, threadID); err != nil {
		return "", err
	}
	return r.startSessionTurn(ctx, threadID, prompt)
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
	threadInput := codex.ThreadInput{CWD: input.CWD, Model: input.Model, ApprovalPolicy: input.ApprovalPolicy, Sandbox: input.Sandbox}
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
	if input.ApprovalPolicy != "" {
		target.ApprovalPolicy = input.ApprovalPolicy
	}
	if input.Sandbox != "" {
		target.Sandbox = input.Sandbox
	}
	target.DeveloperInstructions = developerInstructions()
}

func (r *Runner) startInitialTurn(ctx context.Context, threadID, prompt string) (SessionCreateResult, error) {
	result := SessionCreateResult{ThreadID: threadID}
	if strings.TrimSpace(prompt) == "" {
		return result, nil
	}
	turnID, err := r.startSessionTurn(ctx, threadID, prompt)
	if err != nil {
		return SessionCreateResult{}, err
	}
	result.TurnID = turnID
	return result, nil
}

func (r *Runner) startSessionTurn(ctx context.Context, threadID, prompt string) (string, error) {
	eventsCh, unsubscribe := r.subscribeCodexEvents()
	turnID, err := r.codex.TurnStart(ctx, threadID, strings.TrimSpace(prompt))
	if err != nil {
		unsubscribe()
		return "", err
	}
	r.setSessionRunning(threadID, turnID)
	go r.waitSessionTurn(threadID, turnID, eventsCh, unsubscribe)
	return turnID, nil
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
		if event.Method == "turn/completed" || event.Method == "error" {
			r.clearSessionRunning(threadID, turnID)
			return
		}
	}
}
