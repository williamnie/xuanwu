package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
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
