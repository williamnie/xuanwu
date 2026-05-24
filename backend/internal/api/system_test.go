package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
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
	srv.SetSystemConfig(SystemConfig{CodexCmd: "codex"})
	req := httptest.NewRequest(http.MethodGet, "/api/system/status", nil)
	rr := httptest.NewRecorder()
	srv.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rr.Code, rr.Body.String())
	}

	body := rr.Body.String()
	if strings.Contains(body, "codex-secret-value") || strings.Contains(body, "anthropic-secret-value") {
		t.Fatalf("system status leaked secret: %s", body)
	}
	var status systemStatus
	if err := json.Unmarshal([]byte(body), &status); err != nil {
		t.Fatalf("decode system status: %v", err)
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
