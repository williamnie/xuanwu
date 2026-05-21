package store

const (
	StatusTriage     = "triage"
	StatusTodo       = "todo"
	StatusInProgress = "in_progress"
	StatusDone       = "done"
	StatusFailed     = "failed"
	StatusCancelled  = "cancelled"
)

type Project struct {
	ID             string `json:"id"`
	Name           string `json:"name"`
	CWD            string `json:"cwd"`
	AutoRun        int    `json:"auto_run"`
	Model          string `json:"model"`
	ApprovalPolicy string `json:"approval_policy"`
	Sandbox        string `json:"sandbox"`
	CreatedAt      string `json:"created_at"`
	UpdatedAt      string `json:"updated_at"`
	LoopStatus     string `json:"loop_status,omitempty"`
}

type ProjectPatch struct {
	Name           *string `json:"name"`
	CWD            *string `json:"cwd"`
	AutoRun        *int    `json:"auto_run"`
	Model          *string `json:"model"`
	ApprovalPolicy *string `json:"approval_policy"`
	Sandbox        *string `json:"sandbox"`
}

type Issue struct {
	ID            int64  `json:"id"`
	ProjectID     string `json:"project_id"`
	Title         string `json:"title"`
	Description   string `json:"description"`
	Status        string `json:"status"`
	Priority      int    `json:"priority"`
	CodexThreadID string `json:"codex_thread_id"`
	CodexTurnID   string `json:"codex_turn_id"`
	AttemptCount  int    `json:"attempt_count"`
	Error         string `json:"error"`
	CreatedAt     string `json:"created_at"`
	UpdatedAt     string `json:"updated_at"`
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

type IssueFilter struct {
	ProjectID string
	Status    string
}
