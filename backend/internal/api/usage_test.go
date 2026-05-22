package api

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	codexusage "github.com/xiaobei/codex-issue-runner/backend/internal/usage"
)

func TestCodexUsageAPIReadsConfiguredSessionDir(t *testing.T) {
	root := t.TempDir()
	writeUsageJSONL(t, root, "2026/05/22/session.jsonl", `{"timestamp":"2026-05-22T08:00:00Z","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":10,"output_tokens":5,"total_tokens":15}}}}`)
	srv := newTestServerWithSessionsDir(t, root)

	report := getJSON[codexusage.CodexUsageReport](t, srv, "/api/usage/codex")
	if report.Source != root || report.Summary.AllTime.TotalTokens != 15 {
		t.Fatalf("unexpected usage report: %+v", report)
	}
}

func TestCodexUsageAPIReturnsClearErrorWhenDirMissing(t *testing.T) {
	srv := newTestServerWithSessionsDir(t, "")
	req := httptest.NewRequest(http.MethodGet, "/api/usage/codex", nil)
	rr := httptest.NewRecorder()
	srv.ServeHTTP(rr, req)
	if rr.Code != http.StatusBadRequest || !strings.Contains(rr.Body.String(), "未配置") {
		t.Fatalf("status=%d body=%s", rr.Code, rr.Body.String())
	}
}

func writeUsageJSONL(t *testing.T, root, name, line string) {
	t.Helper()
	path := filepath.Join(root, filepath.FromSlash(name))
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("mkdir usage jsonl: %v", err)
	}
	if err := os.WriteFile(path, []byte(line+"\n"), 0o644); err != nil {
		t.Fatalf("write usage jsonl: %v", err)
	}
}

func newTestServerWithSessionsDir(t *testing.T, sessionsDir string) *Server {
	t.Helper()
	srv := newTestServerWithWeb(t, "")
	srv.codexSessionsDir = sessionsDir
	return srv
}
