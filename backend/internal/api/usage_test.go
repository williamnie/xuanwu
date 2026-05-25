package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/xiaobei/codex-issue-runner/backend/internal/store"
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
	if len(report.ProjectUsage) != 1 || !report.ProjectUsage[0].Unknown {
		t.Fatalf("usage without metadata should stay unknown: %+v", report.ProjectUsage)
	}
}

func TestCodexUsageAPIAddsProjectAndIssueMetadata(t *testing.T) {
	root := t.TempDir()
	projectCWD := filepath.Join(root, "demo")
	writeUsageJSONL(t, root, "2026/05/22/session.jsonl", strings.Join([]string{
		`{"timestamp":"2026-05-22T07:59:00Z","type":"session_meta","payload":{"id":"thread-demo","cwd":"` + projectCWD + `"}}`,
		`{"timestamp":"2026-05-22T08:00:00Z","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":40,"output_tokens":10,"total_tokens":50}}}}`,
	}, "\n"))
	srv := newTestServerWithSessionsDir(t, root)
	project, issue := seedUsageProjectIssue(t, srv, projectCWD)

	report := getJSON[codexusage.CodexUsageReport](t, srv, "/api/usage/codex?limit=1")
	projectUsage := findAPIProjectUsage(report.ProjectUsage, project.ID)
	if projectUsage.Usage.TotalTokens != 50 || projectUsage.Unknown {
		t.Fatalf("project usage mismatch: %+v", projectUsage)
	}
	if len(projectUsage.Sessions) != 1 || projectUsage.Sessions[0].ID != "thread-demo" {
		t.Fatalf("session drilldown mismatch: %+v", projectUsage.Sessions)
	}
	if len(projectUsage.Issues) != 1 || projectUsage.Issues[0].ID != issue.ID {
		t.Fatalf("issue drilldown mismatch: %+v", projectUsage.Issues)
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

func seedUsageProjectIssue(t *testing.T, srv *Server, cwd string) (store.Project, store.Issue) {
	t.Helper()
	project, err := srv.store.CreateProject(context.Background(), store.Project{
		ID: "demo", Name: "Demo", CWD: cwd, AutoRun: 0,
	})
	if err != nil {
		t.Fatalf("create usage project: %v", err)
	}
	issue, err := srv.store.CreateIssue(context.Background(), store.Issue{
		ProjectID: project.ID, Title: "Fix bug", Status: store.StatusDone,
	})
	if err != nil {
		t.Fatalf("create usage issue: %v", err)
	}
	if err := srv.store.UpdateIssueRuntime(context.Background(), issue.ID, "thread-demo", "turn-demo"); err != nil {
		t.Fatalf("update usage runtime: %v", err)
	}
	return project, issue
}

func findAPIProjectUsage(items []codexusage.UsageProjectAggregate, id string) codexusage.UsageProjectAggregate {
	for _, item := range items {
		if item.ID == id {
			return item
		}
	}
	return codexusage.UsageProjectAggregate{}
}
