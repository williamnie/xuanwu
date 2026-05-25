package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestIssueCreateRunsAndPrintsJSON(t *testing.T) {
	bodyPath := filepath.Join(t.TempDir(), "issue.md")
	if err := os.WriteFile(bodyPath, []byte("修复自动化入口\n\n请保持最小改动。"), 0o644); err != nil {
		t.Fatalf("write body file: %v", err)
	}
	requests := []string{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests = append(requests, r.Method+" "+r.URL.Path)
		if r.URL.Path == "/api/issues" {
			var payload map[string]any
			if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
				t.Fatalf("decode create payload: %v", err)
			}
			if payload["project_id"] != "demo" || payload["title"] != "创建 CLI" {
				t.Fatalf("unexpected create payload: %+v", payload)
			}
			if payload["description"] != "修复自动化入口\n\n请保持最小改动。" {
				t.Fatalf("description not read from file: %+v", payload)
			}
			writeTestJSON(w, http.StatusCreated, map[string]any{
				"id": float64(42), "project_id": "demo", "title": "创建 CLI", "status": "triage",
			})
			return
		}
		if r.URL.Path == "/api/issues/42/enqueue" {
			writeTestJSON(w, http.StatusOK, map[string]any{
				"id": float64(42), "project_id": "demo", "title": "创建 CLI", "status": "todo",
			})
			return
		}
		t.Fatalf("unexpected request: %s %s", r.Method, r.URL.Path)
	}))
	defer server.Close()

	var stdout, stderr bytes.Buffer
	code := Run(context.Background(), []string{
		"issue", "create", "--addr", server.URL, "--project", "demo",
		"--title", "创建 CLI", "--body-file", bodyPath, "--run", "--json",
	}, &stdout, &stderr, Options{})
	if code != 0 {
		t.Fatalf("exit=%d stderr=%s", code, stderr.String())
	}
	if got, want := requests, []string{"POST /api/issues", "POST /api/issues/42/enqueue"}; !sameStrings(got, want) {
		t.Fatalf("requests=%v want=%v", got, want)
	}
	var output map[string]any
	if err := json.Unmarshal(stdout.Bytes(), &output); err != nil {
		t.Fatalf("stdout is not JSON: %q err=%v", stdout.String(), err)
	}
	if output["status"] != "todo" || output["id"] != float64(42) {
		t.Fatalf("unexpected output: %+v", output)
	}
}

func TestIssueStatusPrintsHumanSummary(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/api/issues/7" {
			t.Fatalf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		writeTestJSON(w, http.StatusOK, map[string]any{
			"id": float64(7), "project_id": "demo", "title": "补充状态命令", "status": "done",
		})
	}))
	defer server.Close()

	var stdout, stderr bytes.Buffer
	code := Run(context.Background(), []string{
		"issue", "status", "--addr", server.URL, "--id", "7",
	}, &stdout, &stderr, Options{})
	if code != 0 {
		t.Fatalf("exit=%d stderr=%s", code, stderr.String())
	}
	if want := "#7 [done] demo - 补充状态命令\n"; stdout.String() != want {
		t.Fatalf("stdout=%q want=%q", stdout.String(), want)
	}
}

func TestIssueStatusSendsAuthTokenFromEnv(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Authorization"); got != "Bearer env-token" {
			t.Fatalf("authorization = %q", got)
		}
		writeTestJSON(w, http.StatusOK, map[string]any{
			"id": 7, "project_id": "demo", "title": "Fix it", "status": "todo",
		})
	}))
	defer server.Close()

	var out, errOut bytes.Buffer
	code := Run(context.Background(), []string{"issue", "status", "--id", "7", "--addr", server.URL},
		&out, &errOut, Options{Env: func(key string) string {
			if key == "CODEX_RUNNER_AUTH_TOKEN" {
				return "env-token"
			}
			return ""
		}})
	if code != 0 {
		t.Fatalf("code=%d stderr=%s", code, errOut.String())
	}
}

func TestIssueStatusSendsAuthTokenFromTokenFileEnv(t *testing.T) {
	tokenFile := filepath.Join(t.TempDir(), "auth_token")
	if err := os.WriteFile(tokenFile, []byte("file-token\n"), 0o600); err != nil {
		t.Fatalf("write token file: %v", err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Authorization"); got != "Bearer file-token" {
			t.Fatalf("authorization = %q", got)
		}
		writeTestJSON(w, http.StatusOK, map[string]any{
			"id": 7, "project_id": "demo", "title": "Fix it", "status": "todo",
		})
	}))
	defer server.Close()

	var out, errOut bytes.Buffer
	code := Run(context.Background(), []string{"issue", "status", "--id", "7", "--addr", server.URL},
		&out, &errOut, Options{Env: func(key string) string {
			if key == "CODEX_RUNNER_AUTH_TOKEN_FILE" {
				return tokenFile
			}
			return ""
		}})
	if code != 0 {
		t.Fatalf("code=%d stderr=%s", code, errOut.String())
	}
}

func TestSystemStatusGetsStatusWithToken(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/api/system/status" {
			t.Fatalf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		if got := r.Header.Get("Authorization"); got != "Bearer cli-token" {
			t.Fatalf("authorization = %q", got)
		}
		writeTestJSON(w, http.StatusOK, map[string]any{
			"service": map[string]any{"alive": true, "started_at": "2026-05-24T00:00:00Z"},
			"config":  map[string]any{"auth_enabled": true, "codex_cmd": "codex"},
			"db":      map[string]any{"ok": true},
			"codex":   map[string]any{"command": "codex", "command_ok": true, "app_server": "not_checked", "model_list": "not_checked"},
			"runner":  map[string]any{"running_loops": 2, "in_progress_issues": 1},
		})
	}))
	defer server.Close()

	var stdout, stderr bytes.Buffer
	code := Run(context.Background(), []string{
		"system", "status", "--addr", server.URL, "--token", "cli-token", "--json",
	}, &stdout, &stderr, Options{})
	if code != 0 {
		t.Fatalf("exit=%d stderr=%s", code, stderr.String())
	}
	var output map[string]any
	if err := json.Unmarshal(stdout.Bytes(), &output); err != nil {
		t.Fatalf("stdout is not JSON: %q err=%v", stdout.String(), err)
	}
	if output["service"].(map[string]any)["alive"] != true {
		t.Fatalf("unexpected output: %+v", output)
	}
}

func TestSystemStatusPlainOutputListsProviders(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		writeTestJSON(w, http.StatusOK, map[string]any{
			"service": map[string]any{"alive": true},
			"config":  map[string]any{},
			"db":      map[string]any{"ok": true},
			"codex":   map[string]any{"command": "codex", "command_ok": true, "app_server": "not_checked", "model_list": "not_checked"},
			"providers": []map[string]any{
				{
					"id": "codex", "status": "available",
					"cli":     map[string]any{"available": true},
					"secrets": map[string]any{"api_key": map[string]any{"configured": true}},
				},
			},
			"runner": map[string]any{},
		})
	}))
	defer server.Close()

	var stdout, stderr bytes.Buffer
	code := Run(context.Background(), []string{"doctor", "--addr", server.URL}, &stdout, &stderr, Options{})
	if code != 0 {
		t.Fatalf("exit=%d stderr=%s", code, stderr.String())
	}
	if !strings.Contains(stdout.String(), "provider codex status=available") ||
		!strings.Contains(stdout.String(), "api_key:configured") {
		t.Fatalf("provider status missing from output: %s", stdout.String())
	}
}

func TestSystemStatusAliasDoctor(t *testing.T) {
	requestCount := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requestCount++
		if r.URL.Path != "/api/system/status" {
			t.Fatalf("unexpected request path: %s", r.URL.Path)
		}
		writeTestJSON(w, http.StatusOK, map[string]any{
			"service": map[string]any{"alive": true},
			"config":  map[string]any{},
			"db":      map[string]any{"ok": true},
			"codex":   map[string]any{"command": "codex", "command_ok": true, "app_server": "not_checked", "model_list": "not_checked"},
			"runner":  map[string]any{},
		})
	}))
	defer server.Close()

	var stdout, stderr bytes.Buffer
	code := Run(context.Background(), []string{"doctor", "--addr", server.URL, "--json"}, &stdout, &stderr, Options{})
	if code != 0 {
		t.Fatalf("exit=%d stderr=%s", code, stderr.String())
	}
	if requestCount != 1 {
		t.Fatalf("expected one request, got %d", requestCount)
	}
	if err := json.Unmarshal(stdout.Bytes(), &map[string]any{}); err != nil {
		t.Fatalf("stdout not json: %v", err)
	}
}

func TestIssueUpdatePatchesStatusAndError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPatch || r.URL.Path != "/api/issues/7" {
			t.Fatalf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		var payload map[string]any
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Fatalf("decode patch payload: %v", err)
		}
		if payload["status"] != "failed" || payload["error"] != "npm test failed" {
			t.Fatalf("unexpected patch payload: %+v", payload)
		}
		writeTestJSON(w, http.StatusOK, map[string]any{
			"id": float64(7), "project_id": "demo", "title": "验证失败任务",
			"status": "failed", "error": "npm test failed",
		})
	}))
	defer server.Close()

	var stdout, stderr bytes.Buffer
	code := Run(context.Background(), []string{
		"issue", "update", "--addr", server.URL, "--id", "7",
		"--status", "failed", "--error", "npm test failed", "--json",
	}, &stdout, &stderr, Options{})
	if code != 0 {
		t.Fatalf("exit=%d stderr=%s", code, stderr.String())
	}
	var output map[string]any
	if err := json.Unmarshal(stdout.Bytes(), &output); err != nil {
		t.Fatalf("stdout is not JSON: %q err=%v", stdout.String(), err)
	}
	if output["status"] != "failed" || output["error"] != "npm test failed" {
		t.Fatalf("unexpected output: %+v", output)
	}
}

func TestIssueRetryPostsAction(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/api/issues/9/retry" {
			t.Fatalf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		writeTestJSON(w, http.StatusOK, map[string]any{
			"id": float64(9), "project_id": "demo", "title": "重试失败任务", "status": "todo",
		})
	}))
	defer server.Close()

	var stdout, stderr bytes.Buffer
	code := Run(context.Background(), []string{
		"issue", "retry", "--addr", server.URL, "--id", "9", "--json",
	}, &stdout, &stderr, Options{})
	if code != 0 {
		t.Fatalf("exit=%d stderr=%s", code, stderr.String())
	}
	var output map[string]any
	if err := json.Unmarshal(stdout.Bytes(), &output); err != nil {
		t.Fatalf("stdout is not JSON: %q err=%v", stdout.String(), err)
	}
	if output["status"] != "todo" {
		t.Fatalf("unexpected output: %+v", output)
	}
}

func writeTestJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func sameStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func TestProjectCreatePostsProject(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/api/projects" {
			t.Fatalf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		var payload map[string]any
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Fatalf("decode project payload: %v", err)
		}
		if payload["id"] != "demo" || payload["cwd"] != "/tmp/demo" || payload["auto_run"] != float64(1) {
			t.Fatalf("unexpected project payload: %+v", payload)
		}
		writeTestJSON(w, http.StatusCreated, map[string]any{
			"id": "demo", "name": "demo", "cwd": "/tmp/demo", "auto_run": float64(1), "loop_status": "running",
		})
	}))
	defer server.Close()

	var stdout, stderr bytes.Buffer
	code := Run(context.Background(), []string{
		"project", "create", "--addr", server.URL, "--id", "demo", "--cwd", "/tmp/demo", "--auto-run", "--json",
	}, &stdout, &stderr, Options{})
	if code != 0 {
		t.Fatalf("exit=%d stderr=%s", code, stderr.String())
	}
	var output map[string]any
	if err := json.Unmarshal(stdout.Bytes(), &output); err != nil {
		t.Fatalf("stdout is not JSON: %q err=%v", stdout.String(), err)
	}
	if output["loop_status"] != "running" {
		t.Fatalf("unexpected output: %+v", output)
	}
}
