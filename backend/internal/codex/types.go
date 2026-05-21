package codex

import "context"

type ThreadInput struct {
	CWD                   string
	Model                 string
	ApprovalPolicy        string
	Sandbox               string
	DeveloperInstructions string
}

type Event struct {
	Method   string
	ThreadID string
	TurnID   string
	Text     string
	Status   string
	Error    string
	Payload  string
}

type Client interface {
	Start(ctx context.Context) error
	Stop(ctx context.Context) error
	ThreadStart(ctx context.Context, input ThreadInput) (string, error)
	ThreadList(ctx context.Context, input SessionListInput) (SessionListResult, error)
	ThreadRead(ctx context.Context, threadID string) (Session, error)
	ThreadResume(ctx context.Context, threadID string) (Session, error)
	TurnStart(ctx context.Context, threadID, prompt string) (string, error)
	InterruptTurn(ctx context.Context, threadID, turnID string) error
	Events() <-chan Event
}
