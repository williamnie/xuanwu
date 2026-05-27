package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/xiaobei/codex-issue-runner/backend/internal/store"
)

func TestSystemRestartAPI(t *testing.T) {
	srv := newTestServer(t)
	restarted := make(chan struct{}, 1)
	srv.SetRestartFunc(func() {
		restarted <- struct{}{}
	})

	req := httptest.NewRequest(http.MethodPost, "/api/system/restart", strings.NewReader("{}"))
	rr := httptest.NewRecorder()
	srv.ServeHTTP(rr, req)
	if rr.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s, want %d", rr.Code, rr.Body.String(), http.StatusAccepted)
	}
	if !strings.Contains(rr.Body.String(), "restarting") {
		t.Fatalf("body=%s, want restarting status", rr.Body.String())
	}
	select {
	case <-restarted:
	case <-time.After(time.Second):
		t.Fatal("restart function was not called")
	}
}

func TestSystemStatusIncludesProviderAvailabilityWithoutSecrets(t *testing.T) {
	codexDir := t.TempDir()
	codexBin := filepath.Join(codexDir, "codex")
	if err := os.WriteFile(codexBin, []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
		t.Fatalf("write fake codex: %v", err)
	}
	oldPath := os.Getenv("PATH")
	t.Setenv("PATH", codexDir+string(os.PathListSeparator)+oldPath)
	t.Setenv("CODEX_API_KEY", "codex-secret-value")
	t.Setenv("ANTHROPIC_API_KEY", "anthropic-secret-value")

	srv := newTestServer(t)
	srv.SetAuthToken("secret-token")
	srv.SetSystemConfig(SystemConfig{CodexCmd: "codex"})
	req := httptest.NewRequest(http.MethodGet, "/api/system/status", nil)
	req.Header.Set("Authorization", "Bearer secret-token")
	rr := httptest.NewRecorder()
	srv.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rr.Code, rr.Body.String())
	}

	body := rr.Body.String()
	if strings.Contains(body, "codex-secret-value") || strings.Contains(body, "anthropic-secret-value") {
		t.Fatalf("system status leaked secret: %s", body)
	}
	assertNoTokenLeak(t, body)
	var status systemStatus
	if err := json.Unmarshal([]byte(body), &status); err != nil {
		t.Fatalf("decode system status: %v", err)
	}
	if status.Service.Version == "" || status.Service.Build.Version == "" {
		t.Fatalf("system status missing build version: %+v", status.Service)
	}
	if status.Service.Build.DistStampStatus == "" {
		t.Fatalf("system status missing build stamp status: %+v", status.Service.Build)
	}
	providers := providerStatusByID(status.Providers)
	if !providers["codex"].Available || !providers["codex"].CLI.Available {
		t.Fatalf("codex provider should be available: %+v", providers["codex"])
	}
	if !providers["codex"].Secrets["api_key"].Configured {
		t.Fatalf("codex api key presence should be reported without value: %+v", providers["codex"].Secrets)
	}
	if !providers["claude"].Secrets["api_key"].Configured {
		t.Fatalf("claude api key presence should be reported without value: %+v", providers["claude"].Secrets)
	}
	if providers["opencode"].Status != "unknown" {
		t.Fatalf("opencode v1 status = %q, want unknown", providers["opencode"].Status)
	}
}

func providerStatusByID(statuses []providerStatus) map[string]providerStatus {
	out := make(map[string]providerStatus, len(statuses))
	for _, status := range statuses {
		out[status.ID] = status
	}
	return out
}

func TestSystemDoctorIncludesRuntimeSummaryWithoutTokens(t *testing.T) {
	srv := newTestServer(t)
	seedDoctorData(t, srv)
	srv.SetAuthToken("secret-token")
	srv.SetSystemConfig(SystemConfig{
		Addr: "127.0.0.1:3008", DBPath: filepath.Join(t.TempDir(), "app.db"),
		CodexCmd: "missing-codex-for-test", AuthEnabled: true, WebMode: "embedded",
	})

	req := httptest.NewRequest(http.MethodGet, "/api/system/doctor", nil)
	req.Header.Set("Authorization", "Bearer secret-token")
	doctor := decodeResponse[runtimeDoctor](t, srv, req, http.StatusOK)

	assertDoctorServiceSummary(t, doctor)
	assertDoctorProjectSummary(t, doctor)
	assertNoTokenLeak(t, mustMarshalDoctor(t, doctor))
}

func TestSystemDoctorWarnsOnUnsafeTransportPreflight(t *testing.T) {
	srv := newTestServer(t)
	srv.SetSystemConfig(SystemConfig{Addr: "0.0.0.0:3008", AllowedOrigins: []string{"*"}})

	req := httptest.NewRequest(http.MethodGet, "/api/system/doctor", nil)
	doctor := decodeResponse[runtimeDoctor](t, srv, req, http.StatusOK)

	assertWarningCode(t, doctor.Security.Warnings, "bind_all_interfaces")
	assertWarningCode(t, doctor.Security.Warnings, "auth_disabled")
	assertWarningCode(t, doctor.Security.Warnings, "origin_wildcard")
}

func TestSystemStatusIncludesSecurityWarnings(t *testing.T) {
	srv := newTestServer(t)
	srv.SetSystemConfig(SystemConfig{Addr: "0.0.0.0:3008", AllowedOrigins: []string{"*"}})

	req := httptest.NewRequest(http.MethodGet, "/api/system/status", nil)
	status := decodeResponse[systemStatus](t, srv, req, http.StatusOK)

	assertWarningCode(t, status.Security.Warnings, "bind_all_interfaces")
	assertWarningCode(t, status.Security.Warnings, "auth_disabled")
	assertWarningCode(t, status.Security.Warnings, "origin_wildcard")
}

func seedDoctorData(t *testing.T, srv *Server) {
	t.Helper()
	running := postJSON[store.Project](t, srv, "/api/projects", map[string]any{
		"id": "demo", "name": "Demo", "cwd": t.TempDir(), "auto_run": 1,
	})
	held, err := srv.store.CreateProject(context.Background(), store.Project{
		ID: "held", Name: "Held", CWD: t.TempDir(), AutoRun: 0,
	})
	if err != nil {
		t.Fatalf("create held project: %v", err)
	}
	_, err = srv.store.SetProjectHold(context.Background(), held.ID, store.ProjectHold{
		Reason: "usage_limit", Message: "paused", LastCheckAt: "2026-05-24T10:00:00Z",
		LastCheckError: "rate limited",
	})
	if err != nil {
		t.Fatalf("set hold: %v", err)
	}
	issue, err := srv.store.CreateIssue(context.Background(), store.Issue{
		ProjectID: running.ID, Title: "failed", Status: store.StatusFailed,
	})
	if err != nil {
		t.Fatalf("create issue: %v", err)
	}
	if _, err := srv.store.SetIssueStatus(context.Background(), issue.ID, store.StatusFailed, "runner boom"); err != nil {
		t.Fatalf("set issue error: %v", err)
	}
	_, err = srv.store.CreateCronTask(context.Background(), store.CronTask{
		Name: "cron", Status: store.CronStatusPaused, Error: "cron boom",
	})
	if err != nil {
		t.Fatalf("create cron task: %v", err)
	}
}

func assertDoctorServiceSummary(t *testing.T, doctor runtimeDoctor) {
	t.Helper()
	if doctor.Service.Version == "" || doctor.Service.Build.Version == "" {
		t.Fatalf("doctor missing version/build: %+v", doctor.Service)
	}
	if doctor.Listen.Addr != "127.0.0.1:3008" || !doctor.Auth.Enabled || !doctor.Auth.CurrentRequestAuthorized {
		t.Fatalf("doctor missing listen/auth summary: %+v", doctor)
	}
	if doctor.RecentErrors.Count != 3 || doctor.RecentErrors.LatestAt == "" {
		t.Fatalf("doctor recent error summary mismatch: %+v", doctor.RecentErrors)
	}
}

func assertDoctorProjectSummary(t *testing.T, doctor runtimeDoctor) {
	t.Helper()
	if doctor.Runner.RunningLoops != 1 || len(doctor.Projects) != 2 {
		t.Fatalf("doctor missing runner/project summary: %+v", doctor)
	}
	project := doctorProjectByID(doctor.Projects, "demo")
	if project.LoopStatus != "running" || !hasString(project.ProviderCapabilities, "issue_execution") {
		t.Fatalf("doctor project summary mismatch: %+v", project)
	}
	if len(doctor.Providers) == 0 || !hasString(doctor.Providers[0].Capabilities, "issue_execution") {
		t.Fatalf("doctor provider capabilities missing: %+v", doctor.Providers)
	}
}

func assertWarningCode(t *testing.T, warnings []securityWarning, code string) {
	t.Helper()
	for _, warning := range warnings {
		if warning.Code == code {
			return
		}
	}
	t.Fatalf("missing warning %q in %+v", code, warnings)
}

func mustMarshalDoctor(t *testing.T, doctor runtimeDoctor) string {
	t.Helper()
	body, err := json.Marshal(doctor)
	if err != nil {
		t.Fatalf("marshal doctor: %v", err)
	}
	return string(body)
}

func doctorProjectByID(projects []doctorProject, id string) doctorProject {
	for _, project := range projects {
		if project.ID == id {
			return project
		}
	}
	return doctorProject{}
}

func hasString(values []string, want string) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}

func assertNoTokenLeak(t *testing.T, body string) {
	t.Helper()
	if strings.Contains(body, "secret-token") || strings.Contains(body, "CODEX_RUNNER_AUTH_TOKEN") {
		t.Fatalf("doctor leaked token material: %s", body)
	}
	if strings.Contains(strings.ToLower(body), "auth_token") {
		t.Fatalf("doctor leaked auth token field: %s", body)
	}
}
