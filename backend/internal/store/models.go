package store

const (
	StatusTriage     = "triage"
	StatusTodo       = "todo"
	StatusInProgress = "in_progress"
	StatusDone       = "done"
	StatusFailed     = "failed"
	StatusCancelled  = "cancelled"
)

const (
	CronActionTriageToTodo = "triage_to_todo"
	CronModeOnce           = "once"
	CronModeDaily          = "daily"
	CronStatusActive       = "active"
	CronStatusPaused       = "paused"
	CronStatusDone         = "done"
)

type Project struct {
	ID             string       `json:"id"`
	Name           string       `json:"name"`
	CWD            string       `json:"cwd"`
	AutoRun        int          `json:"auto_run"`
	Model          string       `json:"model"`
	ApprovalPolicy string       `json:"approval_policy"`
	Sandbox        string       `json:"sandbox"`
	SortOrder      int          `json:"sort_order"`
	CreatedAt      string       `json:"created_at"`
	UpdatedAt      string       `json:"updated_at"`
	LoopStatus     string       `json:"loop_status,omitempty"`
	Hold           *ProjectHold `json:"hold,omitempty"`
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
	Name           *string `json:"name"`
	CWD            *string `json:"cwd"`
	AutoRun        *int    `json:"auto_run"`
	Model          *string `json:"model"`
	ApprovalPolicy *string `json:"approval_policy"`
	Sandbox        *string `json:"sandbox"`
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
	ID             int64  `json:"id"`
	ProjectID      string `json:"project_id"`
	Title          string `json:"title"`
	Description    string `json:"description"`
	Status         string `json:"status"`
	Priority       int    `json:"priority"`
	TemplateID     string `json:"template_id"`
	PromptTemplate string `json:"prompt_template"`
	CodexThreadID  string `json:"codex_thread_id"`
	CodexTurnID    string `json:"codex_turn_id"`
	AttemptCount   int    `json:"attempt_count"`
	Error          string `json:"error"`
	CreatedAt      string `json:"created_at"`
	UpdatedAt      string `json:"updated_at"`
}

type IssuePatch struct {
	Title         *string `json:"title"`
	Description   *string `json:"description"`
	Status        *string `json:"status"`
	Priority      *int    `json:"priority"`
	CodexThreadID *string `json:"codex_thread_id"`
	CodexTurnID   *string `json:"codex_turn_id"`
	Error         *string `json:"error"`
}

type IssueEvent struct {
	ID        int64  `json:"id"`
	IssueID   int64  `json:"issue_id"`
	Type      string `json:"type"`
	Payload   string `json:"payload"`
	CreatedAt string `json:"created_at"`
}

type CronTask struct {
	ID        int64  `json:"id"`
	Name      string `json:"name"`
	ProjectID string `json:"project_id"`
	Action    string `json:"action"`
	Mode      string `json:"mode"`
	TimeOfDay string `json:"time_of_day"`
	NextRunAt string `json:"next_run_at"`
	LastRunAt string `json:"last_run_at"`
	Status    string `json:"status"`
	RunCount  int    `json:"run_count"`
	Error     string `json:"error"`
	CreatedAt string `json:"created_at"`
	UpdatedAt string `json:"updated_at"`
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
	ProjectID string
	Status    string
}
