package store

import "time"

const (
	StatusTriage              = "triage"
	StatusTodo                = "todo"
	StatusInProgress          = "in_progress"
	StatusPendingVerification = "pending_verification"
	StatusDone                = "done"
	StatusFailed              = "failed"
	StatusCancelled           = "cancelled"
)

const ProviderCodex = "codex"

const (
	CronActionTriageToTodo = "triage_to_todo"
	CronModeOnce           = "once"
	CronModeDaily          = "daily"
	CronStatusActive       = "active"
	CronStatusPaused       = "paused"
	CronStatusDone         = "done"
	CronLastStatusSuccess  = "success"
	CronLastStatusSkipped  = "skipped"
	CronLastStatusFailed   = "failed"
)

type AgentProfile struct {
	ID                  string `json:"id"`
	Name                string `json:"name"`
	Provider            string `json:"provider"`
	Model               string `json:"model"`
	ReasoningEffort     string `json:"reasoning_effort"`
	ApprovalPolicy      string `json:"approval_policy"`
	Sandbox             string `json:"sandbox"`
	DefaultInstructions string `json:"default_instructions"`
	SkillIntents        string `json:"skill_intents"`
	PluginIntents       string `json:"plugin_intents"`
	CreatedAt           string `json:"created_at"`
	UpdatedAt           string `json:"updated_at"`
}

type AgentProfilePatch struct {
	Name                *string `json:"name"`
	Provider            *string `json:"provider"`
	Model               *string `json:"model"`
	ReasoningEffort     *string `json:"reasoning_effort"`
	ApprovalPolicy      *string `json:"approval_policy"`
	Sandbox             *string `json:"sandbox"`
	DefaultInstructions *string `json:"default_instructions"`
	SkillIntents        *string `json:"skill_intents"`
	PluginIntents       *string `json:"plugin_intents"`
}

type Project struct {
	ID                    string        `json:"id"`
	Name                  string        `json:"name"`
	CWD                   string        `json:"cwd"`
	Provider              string        `json:"provider"`
	ProviderCapabilities  []string      `json:"provider_capabilities,omitempty"`
	ProviderConfig        string        `json:"provider_config_json"`
	AutoRun               int           `json:"auto_run"`
	Model                 string        `json:"model"`
	ApprovalPolicy        string        `json:"approval_policy"`
	Sandbox               string        `json:"sandbox"`
	DefaultAgentProfileID string        `json:"default_agent_profile_id"`
	DefaultAgentProfile   *AgentProfile `json:"default_agent_profile,omitempty"`
	SortOrder             int           `json:"sort_order"`
	CreatedAt             string        `json:"created_at"`
	UpdatedAt             string        `json:"updated_at"`
	LoopStatus            string        `json:"loop_status,omitempty"`
	Hold                  *ProjectHold  `json:"hold,omitempty"`
}

type ProjectHold struct {
	Reason         string `json:"reason"`
	Message        string `json:"message"`
	HoldSince      string `json:"hold_since"`
	NextCheckAt    string `json:"next_check_at"`
	LastCheckAt    string `json:"last_check_at"`
	LastCheckError string `json:"last_check_error"`
}

type ProjectPatch struct {
	Name                  *string `json:"name"`
	CWD                   *string `json:"cwd"`
	Provider              *string `json:"provider"`
	ProviderConfig        *string `json:"provider_config_json"`
	AutoRun               *int    `json:"auto_run"`
	Model                 *string `json:"model"`
	ApprovalPolicy        *string `json:"approval_policy"`
	Sandbox               *string `json:"sandbox"`
	DefaultAgentProfileID *string `json:"default_agent_profile_id"`
}

type SessionPreferences struct {
	LastProjectID string `json:"last_project_id"`
}

type NotificationSettings struct {
	WebhookURL  string   `json:"webhook_url"`
	Events      []string `json:"events"`
	ActiveStart string   `json:"active_start"`
	ActiveEnd   string   `json:"active_end"`
}

type IssueTemplate struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Content   string `json:"content"`
	IsDefault int    `json:"is_default"`
	CreatedAt string `json:"created_at"`
	UpdatedAt string `json:"updated_at"`
}

type IssueTemplatePatch struct {
	Name      *string `json:"name"`
	Content   *string `json:"content"`
	IsDefault *int    `json:"is_default"`
}

type Issue struct {
	ID              int64     `json:"id"`
	ProjectID       string    `json:"project_id"`
	Title           string    `json:"title"`
	Description     string    `json:"description"`
	Status          string    `json:"status"`
	Priority        int       `json:"priority"`
	TemplateID      string    `json:"template_id"`
	PromptTemplate  string    `json:"prompt_template"`
	AgentProfileID  string    `json:"agent_profile_id"`
	SourceSessionID string    `json:"source_session_id"`
	SourceTurnID    string    `json:"source_turn_id"`
	SourceExcerpt   string    `json:"source_excerpt"`
	CodexThreadID   string    `json:"codex_thread_id"`
	CodexTurnID     string    `json:"codex_turn_id"`
	AttemptCount    int       `json:"attempt_count"`
	CommentCount    int       `json:"comment_count"`
	LatestRun       *IssueRun `json:"latest_run,omitempty"`
	AutoRetryNextAt string    `json:"auto_retry_next_at"`
	AutoRetryReason string    `json:"auto_retry_reason"`
	Error           string    `json:"error"`
	CreatedAt       string    `json:"created_at"`
	UpdatedAt       string    `json:"updated_at"`
}

type IssueRun struct {
	ID                string `json:"id"`
	IssueID           int64  `json:"issue_id"`
	Attempt           int    `json:"attempt"`
	Status            string `json:"status"`
	Provider          string `json:"provider"`
	ProviderSessionID string `json:"provider_session_id"`
	ProviderTurnID    string `json:"provider_turn_id"`
	CodexThreadID     string `json:"codex_thread_id"`
	CodexTurnID       string `json:"codex_turn_id"`
	StartedAt         string `json:"started_at"`
	EndedAt           string `json:"ended_at"`
	ExitReason        string `json:"exit_reason"`
	Error             string `json:"error"`
	AgentProfileID    string `json:"agent_profile_id"`
	CapabilitySummary string `json:"capability_summary"`
	SelectionReason   string `json:"selection_reason"`
}

type IssuePatch struct {
	Title           *string `json:"title"`
	Description     *string `json:"description"`
	Status          *string `json:"status"`
	Priority        *int    `json:"priority"`
	AgentProfileID  *string `json:"agent_profile_id"`
	CodexThreadID   *string `json:"codex_thread_id"`
	CodexTurnID     *string `json:"codex_turn_id"`
	AutoRetryNextAt *string `json:"auto_retry_next_at"`
	AutoRetryReason *string `json:"auto_retry_reason"`
	Error           *string `json:"error"`
}

type IssueRunClosePatch struct {
	IssueID    int64
	Patch      IssuePatch
	RunStatus  string
	ExitReason string
	Error      string
}

type IssueEvent struct {
	ID        int64  `json:"id"`
	IssueID   int64  `json:"issue_id"`
	Type      string `json:"type"`
	Payload   string `json:"payload"`
	CreatedAt string `json:"created_at"`
}

type CronTask struct {
	ID         int64  `json:"id"`
	Name       string `json:"name"`
	ProjectID  string `json:"project_id"`
	Action     string `json:"action"`
	Mode       string `json:"mode"`
	TimeOfDay  string `json:"time_of_day"`
	NextRunAt  string `json:"next_run_at"`
	LastRunAt  string `json:"last_run_at"`
	LastStatus string `json:"last_status"`
	LastResult string `json:"last_result"`
	Status     string `json:"status"`
	RunCount   int    `json:"run_count"`
	Error      string `json:"error"`
	LastError  string `json:"last_error"`
	CreatedAt  string `json:"created_at"`
	UpdatedAt  string `json:"updated_at"`
}

type CronTaskRunRecord struct {
	RanAt      time.Time
	LastStatus string
	LastResult string
}

type CronTaskPatch struct {
	Name      *string `json:"name"`
	ProjectID *string `json:"project_id"`
	Action    *string `json:"action"`
	Mode      *string `json:"mode"`
	TimeOfDay *string `json:"time_of_day"`
	NextRunAt *string `json:"next_run_at"`
	Status    *string `json:"status"`
	Error     *string `json:"error"`
}

type Upload struct {
	ID           string `json:"id"`
	OriginalName string `json:"original_name"`
	MimeType     string `json:"mime_type"`
	SizeBytes    int64  `json:"size_bytes"`
	SHA256       string `json:"sha256"`
	StoragePath  string `json:"storage_path,omitempty"`
	URL          string `json:"url"`
	CreatedAt    string `json:"created_at"`
}

type IssueFilter struct {
	ProjectID       string
	Status          string
	SourceSessionID string
}
