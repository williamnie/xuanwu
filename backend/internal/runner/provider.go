package runner

import (
	"context"
	"fmt"
	"strings"

	"github.com/xiaobei/codex-issue-runner/backend/internal/agent"
)

func (r *Runner) providerID() string {
	return providerKey(r.agent.Name())
}

func providerKey(value string) string {
	return strings.ToLower(strings.TrimSpace(value))
}

func (r *Runner) providerByID(providerID string) (agent.AgentProvider, bool) {
	providerID = providerKey(providerID)
	if providerID == "" || providerID == r.providerID() {
		return r.agent, true
	}
	provider, ok := r.providers[providerID]
	return provider, ok
}

func (r *Runner) providerCapabilities() agent.Capabilities {
	return capabilitiesForProvider(r.agent, r.providerID())
}

func capabilitiesForProvider(provider agent.AgentProvider, providerID string) agent.Capabilities {
	reporter, ok := provider.(agent.CapabilityReporter)
	if ok {
		return reporter.Capabilities()
	}
	return agent.CapabilitiesForProviderID(providerID)
}

func (r *Runner) hasCapability(capability agent.Capability) bool {
	return r.providerCapabilities().Supports(capability)
}

func (r *Runner) requireCapability(capability agent.Capability) error {
	if r.hasCapability(capability) {
		return nil
	}
	return fmt.Errorf("provider %q 不支持 capability %q", r.providerID(), capability)
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

func (r *Runner) pendingApprovals(ctx context.Context) ([]agent.PendingApproval, error) {
	capability, ok := r.agent.(agent.ApprovalLister)
	if !ok {
		return nil, agent.ErrCapabilityUnsupported
	}
	return capability.PendingApprovals(ctx)
}
