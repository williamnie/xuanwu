package agent

import "context"

// AgentProvider is the v1 provider seam used by the runner for the common
// execution path. Less universal features live in optional capability
// interfaces instead of being forced on every provider.
type AgentProvider interface {
	Name() string
	Start(ctx context.Context) error
	StartThread(ctx context.Context, input ThreadInput) (string, error)
	StartTurn(ctx context.Context, threadID string, input []UserInput, options TurnOptions) (string, error)
	Events() <-chan Event
}
