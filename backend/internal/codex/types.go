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

type UserInput struct {
	Type         string `json:"type"`
	Text         string `json:"text,omitempty"`
	TextElements []any  `json:"text_elements,omitempty"`
	URL          string `json:"url,omitempty"`
	Path         string `json:"path,omitempty"`
	Name         string `json:"name,omitempty"`
}

type Client interface {
	Start(ctx context.Context) error
	Stop(ctx context.Context) error
	ThreadStart(ctx context.Context, input ThreadInput) (string, error)
	ThreadList(ctx context.Context, input SessionListInput) (SessionListResult, error)
	ThreadRead(ctx context.Context, threadID string) (Session, error)
	ThreadResume(ctx context.Context, threadID string) (Session, error)
	ThreadSetName(ctx context.Context, threadID, name string) error
	TurnStart(ctx context.Context, threadID string, input []UserInput) (string, error)
	InterruptTurn(ctx context.Context, threadID, turnID string) error
	Events() <-chan Event
}
