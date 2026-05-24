package codex

import (
	"context"
	"sync"

	"github.com/xiaobei/codex-issue-runner/backend/internal/agent"
	codexclient "github.com/xiaobei/codex-issue-runner/backend/internal/codex"
	"github.com/xiaobei/codex-issue-runner/backend/internal/events"
)

type Provider struct {
	client codexclient.Client
	once   sync.Once
	events chan agent.Event
}

func New(client codexclient.Client) *Provider {
	return &Provider{client: client, events: make(chan agent.Event, 256)}
}

func (p *Provider) Name() string { return events.ProviderCodex }

func (p *Provider) Capabilities() agent.Capabilities { return agent.CodexCapabilities() }

func (p *Provider) Start(ctx context.Context) error { return p.client.Start(ctx) }

func (p *Provider) Stop(ctx context.Context) error { return p.client.Stop(ctx) }

func (p *Provider) ListModels(
	ctx context.Context,
	input agent.ModelListInput,
) (agent.ModelListResult, error) {
	result, err := p.client.ModelList(ctx, toCodexModelListInput(input))
	return fromCodexModelListResult(result), err
}

func (p *Provider) StartThread(ctx context.Context, input agent.ThreadInput) (string, error) {
	return p.client.ThreadStart(ctx, toCodexThreadInput(input))
}

func (p *Provider) ListThreads(
	ctx context.Context,
	input agent.SessionListInput,
) (agent.SessionListResult, error) {
	result, err := p.client.ThreadList(ctx, toCodexSessionListInput(input))
	return fromCodexSessionListResult(result), err
}

func (p *Provider) ReadThread(ctx context.Context, threadID string) (agent.Session, error) {
	session, err := p.client.ThreadRead(ctx, threadID)
	return fromCodexSession(session), err
}

func (p *Provider) ResumeThread(ctx context.Context, threadID string) (agent.Session, error) {
	session, err := p.client.ThreadResume(ctx, threadID)
	return fromCodexSession(session), err
}

func (p *Provider) SetThreadName(ctx context.Context, threadID, name string) error {
	return p.client.ThreadSetName(ctx, threadID, name)
}

func (p *Provider) StartTurn(
	ctx context.Context,
	threadID string,
	input []agent.UserInput,
	options agent.TurnOptions,
) (string, error) {
	return p.client.TurnStart(ctx, threadID, toCodexUserInputs(input), toCodexTurnOptions(options))
}

func (p *Provider) InterruptTurn(ctx context.Context, threadID, turnID string) error {
	return p.client.InterruptTurn(ctx, threadID, turnID)
}

func (p *Provider) ResolveApproval(
	ctx context.Context,
	requestID string,
	decision agent.ApprovalDecision,
) error {
	return p.client.ResolveApproval(ctx, requestID, toCodexApprovalDecision(decision))
}

func (p *Provider) Events() <-chan agent.Event {
	p.once.Do(func() { go p.convertEvents() })
	return p.events
}

func (p *Provider) convertEvents() {
	defer close(p.events)
	for event := range p.client.Events() {
		p.events <- fromCodexEvent(event)
	}
}
