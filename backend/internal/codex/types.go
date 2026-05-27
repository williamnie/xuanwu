package codex

import "context"

const (
	ThreadSourceUser                = "user"
	ThreadSourceSubagent            = "subagent"
	ThreadSourceMemoryConsolidation = "memory_consolidation"
)

type ThreadInput struct {
	CWD                   string
	Model                 string
	ReasoningEffort       string
	ApprovalPolicy        string
	Sandbox               string
	DeveloperInstructions string
	ThreadSource          string
}

type TurnOptions struct {
	Model           string
	ReasoningEffort string
	ApprovalPolicy  string
	Sandbox         string
}

type Event struct {
	Method         string
	AgentEventType string
	Provider       string
	RawMethod      string
	RawPayload     string
	ThreadID       string
	TurnID         string
	Text           string
	Command        string
	Path           string
	Status         string
	Error          string
	Payload        string
}

type UserInput struct {
	Type         string `json:"type"`
	Text         string `json:"text,omitempty"`
	TextElements []any  `json:"text_elements,omitempty"`
	URL          string `json:"url,omitempty"`
	Path         string `json:"path,omitempty"`
	Name         string `json:"name,omitempty"`
}

type ModelListInput struct {
	IncludeHidden bool
}

type ModelListResult struct {
	Data       []Model `json:"data"`
	NextCursor string  `json:"nextCursor,omitempty"`
}

type Model struct {
	ID                        string                  `json:"id"`
	Model                     string                  `json:"model"`
	DisplayName               string                  `json:"displayName"`
	Description               string                  `json:"description"`
	IsDefault                 bool                    `json:"isDefault"`
	Hidden                    bool                    `json:"hidden"`
	DefaultReasoningEffort    string                  `json:"defaultReasoningEffort"`
	SupportedReasoningEfforts []ReasoningEffortOption `json:"supportedReasoningEfforts"`
	InputModalities           []string                `json:"inputModalities,omitempty"`
}

type ReasoningEffortOption struct {
	ReasoningEffort string `json:"reasoningEffort"`
	Description     string `json:"description"`
}

type ApprovalDecision struct {
	Decision string `json:"decision"`
	Scope    string `json:"scope,omitempty"`
}

type PendingApproval struct {
	ID       string         `json:"id"`
	Method   string         `json:"method"`
	Params   map[string]any `json:"params"`
	ThreadID string         `json:"thread_id,omitempty"`
	TurnID   string         `json:"turn_id,omitempty"`
}

type Client interface {
	Start(ctx context.Context) error
	Stop(ctx context.Context) error
	ThreadStart(ctx context.Context, input ThreadInput) (string, error)
	ModelList(ctx context.Context, input ModelListInput) (ModelListResult, error)
	ThreadList(ctx context.Context, input SessionListInput) (SessionListResult, error)
	ThreadRead(ctx context.Context, threadID string) (Session, error)
	ThreadResume(ctx context.Context, threadID string) (Session, error)
	ThreadSetName(ctx context.Context, threadID, name string) error
	TurnStart(ctx context.Context, threadID string, input []UserInput, options TurnOptions) (string, error)
	TurnSteer(ctx context.Context, threadID string, turnID string, input []UserInput) (string, error)
	InterruptTurn(ctx context.Context, threadID, turnID string) error
	PendingApprovals(ctx context.Context) ([]PendingApproval, error)
	ResolveApproval(ctx context.Context, requestID string, decision ApprovalDecision) error
	Events() <-chan Event
}
