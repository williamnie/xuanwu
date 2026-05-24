package runner

import (
	"context"

	"github.com/xiaobei/codex-issue-runner/backend/internal/agent"
)

func (r *Runner) listModels(ctx context.Context) (agent.ModelListResult, error) {
	capability, ok := r.agent.(agent.ModelLister)
	if !ok {
		return agent.ModelListResult{}, agent.ErrCapabilityUnsupported
	}
	return capability.ListModels(ctx, agent.ModelListInput{})
}

func (r *Runner) listThreads(
	ctx context.Context,
	input agent.SessionListInput,
) (agent.SessionListResult, error) {
	capability, ok := r.agent.(agent.ThreadLister)
	if !ok {
		return agent.SessionListResult{}, agent.ErrCapabilityUnsupported
	}
	return capability.ListThreads(ctx, input)
}

func (r *Runner) resumeThread(ctx context.Context, threadID string) (agent.Session, error) {
	capability, ok := r.agent.(agent.ThreadResumer)
	if !ok {
		return agent.Session{}, agent.ErrCapabilityUnsupported
	}
	return capability.ResumeThread(ctx, threadID)
}

func (r *Runner) setThreadName(ctx context.Context, threadID, name string) error {
	capability, ok := r.agent.(agent.ThreadNamer)
	if !ok {
		return agent.ErrCapabilityUnsupported
	}
	return capability.SetThreadName(ctx, threadID, name)
}

func (r *Runner) interruptTurn(ctx context.Context, threadID, turnID string) error {
	capability, ok := r.agent.(agent.TurnInterrupter)
	if !ok {
		return agent.ErrCapabilityUnsupported
	}
	return capability.InterruptTurn(ctx, threadID, turnID)
}

func (r *Runner) resolveApproval(
	ctx context.Context,
	requestID string,
	decision agent.ApprovalDecision,
) error {
	capability, ok := r.agent.(agent.ApprovalResolver)
	if !ok {
		return agent.ErrCapabilityUnsupported
	}
	return capability.ResolveApproval(ctx, requestID, decision)
}
