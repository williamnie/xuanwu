package codex

import "encoding/json"

const (
	SessionOriginCodexApp = "codex_app"
	SessionOriginRunner   = "runner"
)

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
	ID            string          `json:"id"`
	SessionID     string          `json:"sessionId,omitempty"`
	ForkedFromID  *string         `json:"forkedFromId,omitempty"`
	Preview       string          `json:"preview,omitempty"`
	Ephemeral     bool            `json:"ephemeral"`
	ModelProvider string          `json:"modelProvider,omitempty"`
	CreatedAt     int64           `json:"createdAt,omitempty"`
	UpdatedAt     int64           `json:"updatedAt,omitempty"`
	Status        json.RawMessage `json:"status,omitempty"`
	Path          string          `json:"path,omitempty"`
	CWD           string          `json:"cwd,omitempty"`
	CLIVersion    string          `json:"cliVersion,omitempty"`
	Source        string          `json:"source,omitempty"`
	ThreadSource  *string         `json:"threadSource,omitempty"`
	AgentNickname *string         `json:"agentNickname,omitempty"`
	AgentRole     *string         `json:"agentRole,omitempty"`
	GitInfo       json.RawMessage `json:"gitInfo,omitempty"`
	Name          *string         `json:"name,omitempty"`
	Turns         json.RawMessage `json:"turns,omitempty"`
	IsRunning     bool            `json:"isRunning,omitempty"`
	Origin        string          `json:"origin,omitempty"`
}
