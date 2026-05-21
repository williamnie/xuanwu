package api

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/xiaobei/codex-issue-runner/backend/internal/codex"
	"github.com/xiaobei/codex-issue-runner/backend/internal/events"
	"github.com/xiaobei/codex-issue-runner/backend/internal/runner"
	"github.com/xiaobei/codex-issue-runner/backend/internal/store"
)

type noopCodex struct{ ch chan codex.Event }

func (n noopCodex) Start(context.Context) error { return nil }
func (n noopCodex) Stop(context.Context) error  { return nil }
func (n noopCodex) ThreadStart(context.Context, codex.ThreadInput) (string, error) {
	return "thread-new", nil
}
func (n noopCodex) ThreadList(context.Context, codex.SessionListInput) (codex.SessionListResult, error) {
	return codex.SessionListResult{Data: []codex.Session{{ID: "thread-1", CWD: "/tmp/demo", Preview: "hello"}}, NextCursor: "next"}, nil
}
func (n noopCodex) ThreadRead(context.Context, string) (codex.Session, error) {
	return codex.Session{ID: "thread-1", CWD: "/tmp/demo", Preview: "hello"}, nil
}
func (n noopCodex) ThreadResume(context.Context, string) (codex.Session, error) {
	return codex.Session{ID: "thread-1", CWD: "/tmp/demo"}, nil
}
func (n noopCodex) TurnStart(context.Context, string, string) (string, error) {
	return "turn-new", nil
}
func (n noopCodex) InterruptTurn(context.Context, string, string) error { return nil }
func (n noopCodex) Events() <-chan codex.Event                          { return n.ch }

func TestProjectAndIssueAPI(t *testing.T) {
	srv := newTestServer(t)
	project := postJSON[store.Project](t, srv, "/api/projects", map[string]any{
		"id": "demo", "name": "Demo", "cwd": t.TempDir(), "auto_run": 0,
	})
	if project.ID != "demo" || project.LoopStatus != "stopped" {
		t.Fatalf("unexpected project: %+v", project)
	}
	issue := postJSON[store.Issue](t, srv, "/api/issues", map[string]any{
		"project_id": "demo", "title": "Fix bug", "status": "triage",
	})
	if issue.ID == 0 || issue.Status != "triage" {
		t.Fatalf("unexpected issue: %+v", issue)
	}
	enqueued := postJSON[store.Issue](t, srv, "/api/issues/1/enqueue", map[string]any{})
	if enqueued.Status != store.StatusTodo {
		t.Fatalf("enqueue status: %+v", enqueued)
	}
	events := getJSON[[]store.IssueEvent](t, srv, "/api/issues/1/events")
	if len(events) < 2 {
		t.Fatalf("expected created/status events: %+v", events)
	}
}

func TestSessionAPI(t *testing.T) {
	srv := newTestServer(t)
	list := getJSON[codex.SessionListResult](t, srv, "/api/sessions?limit=20")
	if len(list.Data) != 1 || list.Data[0].ID != "thread-1" || list.NextCursor != "next" {
		t.Fatalf("unexpected sessions: %+v", list)
	}
	created := postJSON[runner.SessionCreateResult](t, srv, "/api/sessions", map[string]any{
		"cwd": t.TempDir(), "prompt": "hello",
	})
	if created.ThreadID != "thread-new" || created.TurnID != "turn-new" {
		t.Fatalf("unexpected created session: %+v", created)
	}
}

type projectSyncTestResponse struct {
	Source  string `json:"source"`
	Summary struct {
		Discovered int `json:"discovered"`
		Created    int `json:"created"`
		Existing   int `json:"existing"`
		Skipped    int `json:"skipped"`
	} `json:"summary"`
	Created  []store.Project `json:"created"`
	Existing []store.Project `json:"existing"`
	Skipped  []struct {
		CWD    string `json:"cwd"`
		Reason string `json:"reason"`
	} `json:"skipped"`
}

func TestSyncCodexProjectsCreatesMissingWorkspaceRoots(t *testing.T) {
	srv := newTestServer(t)
	root := t.TempDir()
	existingPath := filepath.Join(root, "movo-web")
	newPath := filepath.Join(root, "mindnote")
	missingPath := filepath.Join(root, "missing")
	if err := os.Mkdir(existingPath, 0o755); err != nil {
		t.Fatalf("mkdir existing: %v", err)
	}
	if err := os.Mkdir(newPath, 0o755); err != nil {
		t.Fatalf("mkdir new: %v", err)
	}
	postJSON[store.Project](t, srv, "/api/projects", map[string]any{
		"id": "movo-web", "name": "movo-web", "cwd": existingPath, "auto_run": 1,
	})
	statePath := filepath.Join(root, "codex-state.json")
	writeCodexState(t, statePath, existingPath, newPath, missingPath)
	t.Setenv("CODEX_RUNNER_CODEX_STATE", statePath)

	result := postJSON[projectSyncTestResponse](t, srv, "/api/projects/sync/codex", map[string]any{})
	if result.Source != statePath {
		t.Fatalf("source mismatch: %+v", result)
	}
	if result.Summary.Discovered != 4 || result.Summary.Created != 1 ||
		result.Summary.Existing != 1 || result.Summary.Skipped != 2 {
		t.Fatalf("unexpected summary: %+v", result.Summary)
	}
	if len(result.Created) != 1 || result.Created[0].CWD != newPath ||
		result.Created[0].AutoRun != 0 || result.Created[0].Model != "codex-default" {
		t.Fatalf("unexpected created project: %+v", result.Created)
	}

	again := postJSON[projectSyncTestResponse](t, srv, "/api/projects/sync/codex", map[string]any{})
	if again.Summary.Created != 0 || again.Summary.Existing != 2 || again.Summary.Skipped != 2 {
		t.Fatalf("sync should be idempotent: %+v", again.Summary)
	}
}

func writeCodexState(t *testing.T, path, existingPath, newPath, missingPath string) {
	t.Helper()
	state := map[string]any{
		"electron-saved-workspace-roots": []string{existingPath, newPath, missingPath},
		"remote-projects": []map[string]string{
			{"hostId": "remote-ssh-discovered:claw", "remotePath": "/home/xiaobei/project"},
		},
	}
	body, err := json.Marshal(state)
	if err != nil {
		t.Fatalf("marshal state: %v", err)
	}
	if err := os.WriteFile(path, body, 0o644); err != nil {
		t.Fatalf("write state: %v", err)
	}
}

func newTestServer(t *testing.T) *Server {
	t.Helper()
	st, err := store.Open(filepath.Join(t.TempDir(), "app.db"))
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })
	bus := events.NewBus()
	r := runner.New(st, bus, noopCodex{ch: make(chan codex.Event)})
	return NewServer(st, bus, r)
}

func postJSON[T any](t *testing.T, h http.Handler, path string, body any) T {
	t.Helper()
	b, _ := json.Marshal(body)
	req := httptest.NewRequest(http.MethodPost, path, bytes.NewReader(b))
	req.Header.Set("Content-Type", "application/json")
	return decodeResponse[T](t, h, req, http.StatusCreated, http.StatusOK)
}

func getJSON[T any](t *testing.T, h http.Handler, path string) T {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, path, nil)
	return decodeResponse[T](t, h, req, http.StatusOK)
}

func decodeResponse[T any](t *testing.T, h http.Handler, req *http.Request, ok ...int) T {
	t.Helper()
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if !statusOK(rr.Code, ok) {
		t.Fatalf("%s %s status=%d body=%s", req.Method, req.URL.Path, rr.Code, rr.Body.String())
	}
	var out T
	if err := json.Unmarshal(rr.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode response: %v body=%s", err, rr.Body.String())
	}
	return out
}

func statusOK(code int, allowed []int) bool {
	for _, value := range allowed {
		if code == value {
			return true
		}
	}
	return false
}
