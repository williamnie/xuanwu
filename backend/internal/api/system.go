package api

import (
	"context"
	"net/http"
	"strings"
	"time"

	"github.com/xiaobei/codex-issue-runner/backend/internal/config"
	"github.com/xiaobei/codex-issue-runner/backend/internal/store"
)

type SystemConfig struct {
	Addr             string
	DBPath           string
	CodexCmd         string
	ClaudeCmd        string
	OpencodeCmd      string
	CodexSessionsDir string
	AuthEnabled      bool
	AllowedOrigins   []string
	WebMode          string
	LogPaths         []string
}

type systemStatus struct {
	Service   systemServiceStatus `json:"service"`
	Config    systemConfigStatus  `json:"config"`
	Security  securityStatus      `json:"security"`
	DB        checkStatus         `json:"db"`
	Codex     systemCodexStatus   `json:"codex"`
	Providers []providerStatus    `json:"providers"`
	Runner    systemRunnerStatus  `json:"runner"`
}

type systemServiceStatus struct {
	Alive     bool              `json:"alive"`
	Version   string            `json:"version"`
	StartedAt string            `json:"started_at"`
	Build     systemBuildStatus `json:"build"`
}

type systemConfigStatus struct {
	Addr             string `json:"addr"`
	DBPath           string `json:"db_path"`
	CodexCmd         string `json:"codex_cmd"`
	CodexSessionsDir string `json:"codex_sessions_dir"`
	AuthEnabled      bool   `json:"auth_enabled"`
	OriginPolicy     string `json:"origin_policy"`
	WebMode          string `json:"web_mode"`
}

type checkStatus struct {
	OK    bool   `json:"ok"`
	Error string `json:"error,omitempty"`
}

type systemCodexStatus struct {
	Command      string `json:"command"`
	CommandOK    bool   `json:"command_ok"`
	CommandPath  string `json:"command_path,omitempty"`
	CommandError string `json:"command_error,omitempty"`
	AppServer    string `json:"app_server"`
	ModelList    string `json:"model_list"`
}

type providerStatus = config.ProviderStatus

type systemRunnerStatus struct {
	AutoRunProjects  int `json:"auto_run_projects"`
	RunningLoops     int `json:"running_loops"`
	HeldProjects     int `json:"held_projects"`
	InProgressIssues int `json:"in_progress_issues"`
	RunningIssues    int `json:"running_issues"`
	RunningSessions  int `json:"running_sessions"`
}

var appVersion = ""

func (s *Server) routeSystem(w http.ResponseWriter, r *http.Request, parts []string) {
	if len(parts) == 2 && parts[1] == "status" {
		s.handleSystemStatus(w, r)
		return
	}
	if len(parts) == 2 && parts[1] == "doctor" {
		s.handleSystemDoctor(w, r)
		return
	}
	if len(parts) == 2 && parts[1] == "logs" {
		s.handleSystemLogs(w, r)
		return
	}
	if len(parts) == 2 && parts[1] == "restart" {
		s.handleRestart(w, r)
		return
	}
	writeError(w, http.StatusNotFound, "not found")
}

func (s *Server) handleRestart(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodPost) {
		return
	}
	if s.restart == nil {
		writeError(w, http.StatusServiceUnavailable, "restart unavailable")
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]string{
		"status":  "restarting",
		"message": "重启请求已提交",
	})
	if flusher, ok := w.(http.Flusher); ok {
		flusher.Flush()
	}
	go s.restart()
}

func (s *Server) SetSystemConfig(cfg SystemConfig) {
	cfg.Addr = strings.TrimSpace(cfg.Addr)
	cfg.DBPath = strings.TrimSpace(cfg.DBPath)
	cfg.CodexCmd = strings.TrimSpace(cfg.CodexCmd)
	cfg.ClaudeCmd = strings.TrimSpace(cfg.ClaudeCmd)
	cfg.OpencodeCmd = strings.TrimSpace(cfg.OpencodeCmd)
	cfg.CodexSessionsDir = strings.TrimSpace(cfg.CodexSessionsDir)
	cfg.AllowedOrigins = cleanAllowedOrigins(cfg.AllowedOrigins)
	cfg.WebMode = strings.TrimSpace(cfg.WebMode)
	cfg.LogPaths = cleanLogPaths(cfg.LogPaths)
	s.systemConfig = cfg
}

func (s *Server) handleSystemStatus(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodGet) {
		return
	}
	status := s.buildSystemStatus(r.Context())
	writeJSON(w, http.StatusOK, status)
}

func (s *Server) buildSystemStatus(ctx context.Context) systemStatus {
	cfg := s.systemConfig
	if cfg.AuthEnabled != (s.authToken != "") {
		cfg.AuthEnabled = s.authToken != ""
	}
	providers := config.ProviderStatuses(providerSettingsConfig(cfg))
	return systemStatus{
		Service:   s.serviceStatus(),
		Config:    configStatus(cfg),
		Security:  buildSecurityStatus(cfg),
		DB:        s.dbStatus(ctx),
		Codex:     codexStatusFromProviders(cfg.CodexCmd, providers),
		Providers: providers,
		Runner:    s.runnerStatus(ctx),
	}
}

func (s *Server) serviceStatus() systemServiceStatus {
	build := buildStatus()
	return systemServiceStatus{
		Alive:     true,
		Version:   build.Version,
		Build:     build,
		StartedAt: s.startedAt.Format(time.RFC3339),
	}
}

func configStatus(cfg SystemConfig) systemConfigStatus {
	return systemConfigStatus{
		Addr: cfg.Addr, DBPath: cfg.DBPath, CodexCmd: cfg.CodexCmd,
		CodexSessionsDir: cfg.CodexSessionsDir, AuthEnabled: cfg.AuthEnabled,
		OriginPolicy: originPolicyName(cfg.AllowedOrigins), WebMode: cfg.WebMode,
	}
}

func cleanLogPaths(paths []string) []string {
	out := make([]string, 0, len(paths))
	seen := map[string]bool{}
	for _, path := range paths {
		path = strings.TrimSpace(path)
		if path == "" || seen[path] {
			continue
		}
		seen[path] = true
		out = append(out, path)
	}
	return out
}

func (s *Server) dbStatus(ctx context.Context) checkStatus {
	if err := s.store.Ping(ctx); err != nil {
		return checkStatus{OK: false, Error: err.Error()}
	}
	return checkStatus{OK: true}
}

func codexStatusFromProviders(command string, providers []providerStatus) systemCodexStatus {
	command = strings.TrimSpace(command)
	status := systemCodexStatus{Command: command, AppServer: "not_checked", ModelList: "not_checked"}
	codex, ok := providerByID(providers, "codex")
	if !ok {
		status.CommandError = "codex provider status missing"
		return status
	}
	status.Command = codex.CLI.Command
	status.CommandOK = codex.CLI.Available
	status.CommandPath = codex.CLI.Path
	status.CommandError = codex.CLI.Error
	return status
}

func providerSettingsConfig(cfg SystemConfig) config.ProviderSettingsConfig {
	return config.ProviderSettingsConfig{
		CodexCmd: cfg.CodexCmd, ClaudeCmd: cfg.ClaudeCmd, OpencodeCmd: cfg.OpencodeCmd,
	}
}

func providerByID(providers []providerStatus, id string) (providerStatus, bool) {
	for _, provider := range providers {
		if provider.ID == id {
			return provider, true
		}
	}
	return providerStatus{}, false
}

func (s *Server) runnerStatus(ctx context.Context) systemRunnerStatus {
	projects, issues := s.runnerInputs(ctx)
	loops, runningIssues, runningSessions := s.runner.Snapshot()
	return systemRunnerStatus{
		AutoRunProjects:  countAutoRun(projects),
		RunningLoops:     loops,
		HeldProjects:     countHeld(projects),
		InProgressIssues: len(issues),
		RunningIssues:    runningIssues,
		RunningSessions:  runningSessions,
	}
}

func (s *Server) runnerInputs(ctx context.Context) ([]store.Project, []store.Issue) {
	projects, err := s.store.ListProjects(ctx)
	if err != nil {
		projects = nil
	}
	issues, err := s.store.ListIssues(ctx, store.IssueFilter{Status: store.StatusInProgress})
	if err != nil {
		issues = nil
	}
	return projects, issues
}

func countAutoRun(projects []store.Project) int {
	count := 0
	for _, project := range projects {
		if project.AutoRun == 1 {
			count++
		}
	}
	return count
}

func countHeld(projects []store.Project) int {
	count := 0
	for _, project := range projects {
		if project.Hold != nil {
			count++
		}
	}
	return count
}
