package runner

import (
	"context"
	"fmt"

	"github.com/xiaobei/codex-issue-runner/backend/internal/agent"
)

func (r *Runner) hasCapability(capability agent.Capability) bool {
	reporter, ok := r.agent.(agent.CapabilityReporter)
	if !ok {
		return defaultCapability(r.agent.Name(), capability)
	}
	return reporter.Capabilities().Supports(capability)
}

func (r *Runner) requireCapability(capability agent.Capability) error {
	if r.hasCapability(capability) {
		return nil
	}
	return fmt.Errorf("provider %q 不支持 capability %q", r.agent.Name(), capability)
}

func defaultCapability(provider string, capability agent.Capability) bool {
	return agent.CapabilitiesForProviderID(provider).Supports(capability)
}

func (r *Runner) startThread(ctx context.Context, input agent.ThreadInput) (string, error) {
	capability, ok := r.agent.(agent.ThreadStarter)
	if !ok {
		return "", agent.ErrCapabilityUnsupported
	}
	return capability.StartThread(ctx, input)
}

func (r *Runner) startTurn(
	ctx context.Context,
	threadID string,
	input []agent.UserInput,
	options agent.TurnOptions,
) (string, error) {
	capability, ok := r.agent.(agent.TurnStarter)
	if !ok {
		return "", agent.ErrCapabilityUnsupported
	}
	return capability.StartTurn(ctx, threadID, input, options)
}

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
