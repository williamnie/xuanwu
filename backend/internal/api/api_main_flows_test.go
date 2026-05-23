package api

import (
	"testing"

	"github.com/xiaobei/codex-issue-runner/backend/internal/codex"
	"github.com/xiaobei/codex-issue-runner/backend/internal/runner"
	"github.com/xiaobei/codex-issue-runner/backend/internal/store"
)

func TestProjectAPIReadUpdateFlow(t *testing.T) {
	srv := newTestServer(t)
	created := postJSON[store.Project](t, srv, "/api/projects", map[string]any{
		"id": "demo", "name": "Demo", "cwd": t.TempDir(), "auto_run": 0,
	})
	if created.ID != "demo" {
		t.Fatalf("unexpected created project: %+v", created)
	}
	patched := patchJSON[store.Project](t, srv, "/api/projects/demo", map[string]any{
		"name": "Demo Renamed",
	})
	if patched.Name != "Demo Renamed" {
		t.Fatalf("unexpected patched project: %+v", patched)
	}
	got := getJSON[store.Project](t, srv, "/api/projects/demo")
	if got.ID != "demo" || got.Name != "Demo Renamed" {
		t.Fatalf("unexpected fetched project: %+v", got)
	}
}

func TestIssueAPIListReadUpdateFlow(t *testing.T) {
	srv := newTestServer(t)
	postJSON[store.Project](t, srv, "/api/projects", map[string]any{
		"id": "demo", "cwd": t.TempDir(), "auto_run": 0,
	})
	issue := postJSON[store.Issue](t, srv, "/api/issues", map[string]any{
		"project_id": "demo", "description": "Fix bug from content", "status": "triage",
	})
	listed := getJSON[[]store.Issue](t, srv, "/api/issues?projectId=demo&status=triage")
	if len(listed) != 1 || listed[0].ID != issue.ID {
		t.Fatalf("unexpected filtered issues: %+v", listed)
	}
	got := getJSON[store.Issue](t, srv, "/api/issues/1")
	if got.ID != issue.ID || got.ProjectID != "demo" {
		t.Fatalf("unexpected fetched issue: %+v", got)
	}
	patched := patchJSON[store.Issue](t, srv, "/api/issues/1", map[string]any{
		"title": "Fix bug renamed",
	})
	if patched.Title != "Fix bug renamed" {
		t.Fatalf("unexpected patched issue: %+v", patched)
	}
}

func TestIssueRunsAPI(t *testing.T) {
	srv := newTestServer(t)
	ctx := t.Context()
	postJSON[store.Project](t, srv, "/api/projects", map[string]any{
		"id": "demo", "cwd": t.TempDir(), "auto_run": 0,
	})
	issue := postJSON[store.Issue](t, srv, "/api/issues", map[string]any{
		"project_id": "demo", "title": "run history", "status": "todo",
	})
	claimed, ok, err := srv.store.ClaimNextIssue(ctx, "demo")
	if err != nil || !ok {
		t.Fatalf("claim issue: ok=%v err=%v", ok, err)
	}
	if err := srv.store.UpdateIssueRuntime(ctx, claimed.ID, "thread-1", "turn-1"); err != nil {
		t.Fatalf("update runtime: %v", err)
	}
	if _, err := srv.store.SetIssueStatus(ctx, claimed.ID, store.StatusDone, ""); err != nil {
		t.Fatalf("mark done: %v", err)
	}

	runs := getJSON[[]store.IssueRun](t, srv, "/api/issues/1/runs")
	if len(runs) != 1 || runs[0].IssueID != issue.ID || runs[0].Status != store.StatusDone ||
		runs[0].CodexThreadID != "thread-1" || runs[0].CodexTurnID != "turn-1" ||
		runs[0].StartedAt == "" || runs[0].EndedAt == "" {
		t.Fatalf("unexpected runs response: %+v", runs)
	}
}

func TestSessionAPIReadAndMessageFlow(t *testing.T) {
	srv := newTestServerWithCodex(t, noopCodex{ch: make(chan codex.Event)})
	session := getJSON[codex.Session](t, srv, "/api/sessions/thread-1")
	if session.ID != "thread-1" || session.CWD != "/tmp/demo" {
		t.Fatalf("unexpected session detail: %+v", session)
	}
	created := postJSON[runner.SessionCreateResult](t, srv, "/api/sessions", map[string]any{
		"cwd": t.TempDir(), "prompt": "hello",
	})
	if created.ThreadID != "thread-new" || created.TurnID != "turn-new" {
		t.Fatalf("unexpected created session: %+v", created)
	}
	message := postJSON[map[string]string](t, srv, "/api/sessions/thread-1/messages", map[string]any{
		"prompt": "continue",
	})
	if message["thread_id"] != "thread-1" || message["turn_id"] != "turn-new" {
		t.Fatalf("unexpected session message: %+v", message)
	}
}
