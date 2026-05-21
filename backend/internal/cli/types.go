package cli

import "net/http"

type Options struct {
	HTTPClient *http.Client
	Env        func(string) string
}

type issueDTO struct {
	ID             int64  `json:"id"`
	ProjectID      string `json:"project_id"`
	Title          string `json:"title"`
	Description    string `json:"description,omitempty"`
	Status         string `json:"status"`
	Priority       int    `json:"priority,omitempty"`
	TemplateID     string `json:"template_id,omitempty"`
	PromptTemplate string `json:"prompt_template,omitempty"`
	CodexThreadID  string `json:"codex_thread_id,omitempty"`
	CodexTurnID    string `json:"codex_turn_id,omitempty"`
	AttemptCount   int    `json:"attempt_count,omitempty"`
	Error          string `json:"error,omitempty"`
	CreatedAt      string `json:"created_at,omitempty"`
	UpdatedAt      string `json:"updated_at,omitempty"`
}

type issueEventDTO struct {
	ID        int64  `json:"id"`
	IssueID   int64  `json:"issue_id"`
	Type      string `json:"type"`
	Payload   string `json:"payload"`
	CreatedAt string `json:"created_at"`
}

type projectDTO struct {
	ID             string `json:"id"`
	Name           string `json:"name"`
	CWD            string `json:"cwd"`
	AutoRun        int    `json:"auto_run"`
	Model          string `json:"model,omitempty"`
	ApprovalPolicy string `json:"approval_policy,omitempty"`
	Sandbox        string `json:"sandbox,omitempty"`
	LoopStatus     string `json:"loop_status,omitempty"`
}
