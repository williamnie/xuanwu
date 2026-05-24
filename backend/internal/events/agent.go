package events

import "encoding/json"

const (
	ProviderCodex = "codex"
)

const (
	AgentMessageDelta       = "agent.message.delta"
	AgentCommandStarted     = "agent.command.started"
	AgentCommandOutputDelta = "agent.command.output_delta"
	AgentCommandCompleted   = "agent.command.completed"
	AgentFilePatch          = "agent.file.patch"
	AgentApprovalRequested  = "agent.approval.requested"
	AgentTurnStarted        = "agent.turn.started"
	AgentTurnCompleted      = "agent.turn.completed"
	AgentError              = "agent.error"
)

type AgentEventPayload struct {
	Type       string          `json:"type"`
	Provider   string          `json:"provider,omitempty"`
	RawMethod  string          `json:"raw_method,omitempty"`
	RawPayload json.RawMessage `json:"raw_payload,omitempty"`
	Payload    json.RawMessage `json:"payload,omitempty"`
	Text       string          `json:"text,omitempty"`
	Command    string          `json:"command,omitempty"`
	Path       string          `json:"path,omitempty"`
	Status     string          `json:"status,omitempty"`
	Error      string          `json:"error,omitempty"`
}
