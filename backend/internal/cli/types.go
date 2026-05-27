package cli

import "net/http"

type Options struct {
	HTTPClient *http.Client
	Env        func(string) string
}

type issueDTO struct {
	ID              int64  `json:"id"`
	ProjectID       string `json:"project_id"`
	Title           string `json:"title"`
	Description     string `json:"description,omitempty"`
	Status          string `json:"status"`
	Priority        int    `json:"priority,omitempty"`
	TemplateID      string `json:"template_id,omitempty"`
	PromptTemplate  string `json:"prompt_template,omitempty"`
	SourceSessionID string `json:"source_session_id,omitempty"`
	SourceTurnID    string `json:"source_turn_id,omitempty"`
	SourceExcerpt   string `json:"source_excerpt,omitempty"`
	CodexThreadID   string `json:"codex_thread_id,omitempty"`
	CodexTurnID     string `json:"codex_turn_id,omitempty"`
	AttemptCount    int    `json:"attempt_count,omitempty"`
	Error           string `json:"error,omitempty"`
	CreatedAt       string `json:"created_at,omitempty"`
	UpdatedAt       string `json:"updated_at,omitempty"`
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
	Provider       string `json:"provider,omitempty"`
	ProviderConfig string `json:"provider_config_json,omitempty"`
	AutoRun        int    `json:"auto_run"`
	Model          string `json:"model,omitempty"`
	ApprovalPolicy string `json:"approval_policy,omitempty"`
	Sandbox        string `json:"sandbox,omitempty"`
	LoopStatus     string `json:"loop_status,omitempty"`
}

type systemStatusDTO struct {
	Service struct {
		Alive     bool           `json:"alive"`
		Version   string         `json:"version"`
		StartedAt string         `json:"started_at"`
		Build     map[string]any `json:"build,omitempty"`
	} `json:"service"`
	Config struct {
		Addr             string `json:"addr"`
		DBPath           string `json:"db_path"`
		CodexCmd         string `json:"codex_cmd"`
		CodexSessionsDir string `json:"codex_sessions_dir"`
		AuthEnabled      bool   `json:"auth_enabled"`
		OriginPolicy     string `json:"origin_policy"`
		WebMode          string `json:"web_mode"`
	} `json:"config"`
	Security struct {
		Warnings []securityWarningDTO `json:"warnings,omitempty"`
	} `json:"security"`
	DB struct {
		OK    bool   `json:"ok"`
		Error string `json:"error,omitempty"`
	} `json:"db"`
	Codex struct {
		Command      string `json:"command"`
		CommandOK    bool   `json:"command_ok"`
		CommandPath  string `json:"command_path,omitempty"`
		CommandError string `json:"command_error,omitempty"`
		AppServer    string `json:"app_server"`
		ModelList    string `json:"model_list"`
	} `json:"codex"`
	Providers []providerStatusDTO `json:"providers"`
	Runner    struct {
		AutoRunProjects  int `json:"auto_run_projects"`
		RunningLoops     int `json:"running_loops"`
		HeldProjects     int `json:"held_projects"`
		InProgressIssues int `json:"in_progress_issues"`
		RunningIssues    int `json:"running_issues"`
		RunningSessions  int `json:"running_sessions"`
	} `json:"runner"`
}

type securityWarningDTO struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

type providerStatusDTO struct {
	ID        string                     `json:"id"`
	Label     string                     `json:"label"`
	Status    string                     `json:"status"`
	Available bool                       `json:"available"`
	Enabled   bool                       `json:"enabled"`
	CLI       providerCLIStatusDTO       `json:"cli"`
	Secrets   map[string]secretStatusDTO `json:"secrets,omitempty"`
}

type providerCLIStatusDTO struct {
	Command   string `json:"command"`
	Available bool   `json:"available"`
	Path      string `json:"path,omitempty"`
	Error     string `json:"error,omitempty"`
}

type secretStatusDTO struct {
	Configured bool `json:"configured"`
}
