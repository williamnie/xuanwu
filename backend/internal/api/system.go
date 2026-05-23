package api

import (
	"context"
	"net/http"
	"os/exec"
	"strings"
	"time"

	"github.com/xiaobei/codex-issue-runner/backend/internal/store"
)

type SystemConfig struct {
	Addr             string
	DBPath           string
	CodexCmd         string
	CodexSessionsDir string
	AuthEnabled      bool
	WebMode          string
}

type systemStatus struct {
	Service systemServiceStatus `json:"service"`
	Config  systemConfigStatus  `json:"config"`
	DB      checkStatus         `json:"db"`
	Codex   systemCodexStatus   `json:"codex"`
	Runner  systemRunnerStatus  `json:"runner"`
}

type systemServiceStatus struct {
	Alive     bool   `json:"alive"`
	Version   string `json:"version"`
	StartedAt string `json:"started_at"`
}

type systemConfigStatus struct {
	Addr             string `json:"addr"`
	DBPath           string `json:"db_path"`
	CodexCmd         string `json:"codex_cmd"`
	CodexSessionsDir string `json:"codex_sessions_dir"`
	AuthEnabled      bool   `json:"auth_enabled"`
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

type systemRunnerStatus struct {
	AutoRunProjects  int `json:"auto_run_projects"`
	RunningLoops     int `json:"running_loops"`
	HeldProjects     int `json:"held_projects"`
	InProgressIssues int `json:"in_progress_issues"`
	RunningIssues    int `json:"running_issues"`
	RunningSessions  int `json:"running_sessions"`
}

const appVersion = ""

func (s *Server) routeSystem(w http.ResponseWriter, r *http.Request, parts []string) {
	if len(parts) == 2 && parts[1] == "status" {
		s.handleSystemStatus(w, r)
		return
	}
	if len(parts) == 2 && parts[1] == "doctor" {
		s.handleSystemStatus(w, r)
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
	cfg.CodexSessionsDir = strings.TrimSpace(cfg.CodexSessionsDir)
	cfg.WebMode = strings.TrimSpace(cfg.WebMode)
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
	return systemStatus{
		Service: s.serviceStatus(),
		Config:  configStatus(cfg),
		DB:      s.dbStatus(ctx),
		Codex:   codexStatus(cfg.CodexCmd),
		Runner:  s.runnerStatus(ctx),
	}
}

func (s *Server) serviceStatus() systemServiceStatus {
	return systemServiceStatus{
		Alive:     true,
		Version:   appVersion,
		StartedAt: s.startedAt.Format(time.RFC3339),
	}
}

func configStatus(cfg SystemConfig) systemConfigStatus {
	return systemConfigStatus{
		Addr: cfg.Addr, DBPath: cfg.DBPath, CodexCmd: cfg.CodexCmd,
		CodexSessionsDir: cfg.CodexSessionsDir, AuthEnabled: cfg.AuthEnabled,
		WebMode: cfg.WebMode,
	}
}

func (s *Server) dbStatus(ctx context.Context) checkStatus {
	if err := s.store.Ping(ctx); err != nil {
		return checkStatus{OK: false, Error: err.Error()}
	}
	return checkStatus{OK: true}
}

func codexStatus(command string) systemCodexStatus {
	command = strings.TrimSpace(command)
	status := systemCodexStatus{Command: command, AppServer: "not_checked", ModelList: "not_checked"}
	if command == "" {
		status.CommandError = "codex command is empty"
		return status
	}
	path, err := exec.LookPath(command)
	if err != nil {
		status.CommandError = err.Error()
		return status
	}
	status.CommandOK = true
	status.CommandPath = path
	return status
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
