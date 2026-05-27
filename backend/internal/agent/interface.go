package agent

import "context"

// AgentProvider is the minimal provider seam. Optional execution/session
// features live in capability interfaces so execution-only providers can avoid
// pretending to support Sessions.
type AgentProvider interface {
	Name() string
	Start(ctx context.Context) error
}

type EventStreamer interface {
	Events() <-chan Event
}

type ThreadStarter interface {
	StartThread(ctx context.Context, input ThreadInput) (string, error)
}

type TurnStarter interface {
	StartTurn(ctx context.Context, threadID string, input []UserInput, options TurnOptions) (string, error)
}

type TurnSteerer interface {
	SteerTurn(ctx context.Context, threadID string, turnID string, input []UserInput) (string, error)
}

type IssueRunner interface {
	RunIssue(ctx context.Context, input IssueRunInput) (IssueRunResult, error)
}

type IssueRunInput struct {
	IssueID         int64
	ProjectID       string
	CWD             string
	Prompt          string
	Model           string
	ReasoningEffort string
	ApprovalPolicy  string
	Sandbox         string
	Log             func(Event)
}

type IssueRunResult struct {
	ProviderRunID     string
	ProviderSessionID string
	ProviderTurnID    string
}
