package agent

import "encoding/json"

const (
	ThreadSourceUser                = "user"
	ThreadSourceSubagent            = "subagent"
	ThreadSourceMemoryConsolidation = "memory_consolidation"

	SessionOriginCodexApp = "codex_app"
	SessionOriginRunner   = "runner"
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

type SessionListInput struct {
	Cursor string
	Limit  int
}

type SessionListResult struct {
	Data            []Session `json:"data"`
	NextCursor      string    `json:"nextCursor,omitempty"`
	BackwardsCursor string    `json:"backwardsCursor,omitempty"`
}

type Session struct {
	ID                string          `json:"id"`
	SessionID         string          `json:"sessionId,omitempty"`
	Provider          string          `json:"provider,omitempty"`
	ProviderSessionID string          `json:"provider_session_id,omitempty"`
	ForkedFromID      *string         `json:"forkedFromId,omitempty"`
	Preview           string          `json:"preview,omitempty"`
	Ephemeral         bool            `json:"ephemeral"`
	ModelProvider     string          `json:"modelProvider,omitempty"`
	CreatedAt         int64           `json:"createdAt,omitempty"`
	UpdatedAt         int64           `json:"updatedAt,omitempty"`
	Status            json.RawMessage `json:"status,omitempty"`
	Path              string          `json:"path,omitempty"`
	CWD               string          `json:"cwd,omitempty"`
	CLIVersion        string          `json:"cliVersion,omitempty"`
	Source            string          `json:"source,omitempty"`
	ThreadSource      *string         `json:"threadSource,omitempty"`
	AgentNickname     *string         `json:"agentNickname,omitempty"`
	AgentRole         *string         `json:"agentRole,omitempty"`
	GitInfo           json.RawMessage `json:"gitInfo,omitempty"`
	Name              *string         `json:"name,omitempty"`
	Turns             json.RawMessage `json:"turns,omitempty"`
	IsRunning         bool            `json:"isRunning,omitempty"`
	Origin            string          `json:"origin,omitempty"`
}
