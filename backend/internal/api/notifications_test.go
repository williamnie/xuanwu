package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/xiaobei/codex-issue-runner/backend/internal/store"
)

type notificationSettingsResponse struct {
	WebhookURL  string   `json:"webhook_url"`
	Events      []string `json:"events"`
	ActiveStart string   `json:"active_start"`
	ActiveEnd   string   `json:"active_end"`
}

func TestNotificationSettingsAPIAndWebhookPayload(t *testing.T) {
	srv := newTestServer(t)
	payloads := make(chan map[string]any, 1)
	receiver := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Fatalf("method = %s, want POST", r.Method)
		}
		var payload map[string]any
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Fatalf("decode webhook payload: %v", err)
		}
		payloads <- payload
		w.WriteHeader(http.StatusNoContent)
	}))
	defer receiver.Close()

	settings := patchJSON[notificationSettingsResponse](t, srv, "/api/notifications/settings", map[string]any{
		"webhook_url":  receiver.URL,
		"events":       []string{store.StatusDone},
		"active_start": "",
		"active_end":   "",
	})
	if settings.WebhookURL != receiver.URL || len(settings.Events) != 1 || settings.Events[0] != store.StatusDone {
		t.Fatalf("unexpected notification settings: %+v", settings)
	}

	project := postJSON[store.Project](t, srv, "/api/projects", map[string]any{
		"id": "demo", "name": "Demo", "cwd": t.TempDir(), "auto_run": 0,
	})
	issue := postJSON[store.Issue](t, srv, "/api/issues", map[string]any{
		"project_id": project.ID, "title": "通知测试", "status": store.StatusTodo,
	})
	if err := srv.store.UpdateIssueRuntime(context.Background(), issue.ID, "thread-1", "turn-1"); err != nil {
		t.Fatalf("seed runtime ids: %v", err)
	}

	updated := patchJSON[store.Issue](t, srv, "/api/issues/1", map[string]any{"status": store.StatusDone})
	if updated.Status != store.StatusDone {
		t.Fatalf("issue status = %s, want done", updated.Status)
	}

	payload := waitWebhookPayload(t, payloads)
	if payload["event"] != "issue.done" || payload["title"] != "通知测试" || payload["status"] != store.StatusDone {
		t.Fatalf("unexpected webhook payload: %+v", payload)
	}
	if payload["project"] != "demo" || payload["project_name"] != "Demo" || payload["run_id"] != "turn-1" {
		t.Fatalf("payload missing project/run fields: %+v", payload)
	}
	if payload["issue_id"] != float64(issue.ID) {
		t.Fatalf("issue_id = %#v, want %d", payload["issue_id"], issue.ID)
	}
}

func TestWebhookFailureIsLoggedAndDoesNotBlockIssueUpdate(t *testing.T) {
	srv := newTestServer(t)
	receiver := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "boom", http.StatusInternalServerError)
	}))
	defer receiver.Close()

	_ = patchJSON[notificationSettingsResponse](t, srv, "/api/notifications/settings", map[string]any{
		"webhook_url": receiver.URL,
		"events":      []string{store.StatusDone},
	})
	_ = postJSON[store.Project](t, srv, "/api/projects", map[string]any{
		"id": "demo", "name": "Demo", "cwd": t.TempDir(), "auto_run": 0,
	})
	_ = postJSON[store.Issue](t, srv, "/api/issues", map[string]any{
		"project_id": "demo", "title": "失败日志", "status": store.StatusTodo,
	})

	updated := patchJSON[store.Issue](t, srv, "/api/issues/1", map[string]any{"status": store.StatusDone})
	if updated.Status != store.StatusDone {
		t.Fatalf("issue update should not be blocked by webhook failure: %+v", updated)
	}
	waitIssueEventType(t, srv.store, updated.ID, "issue.notification_failed")
}

func waitWebhookPayload(t *testing.T, payloads <-chan map[string]any) map[string]any {
	t.Helper()
	select {
	case payload := <-payloads:
		return payload
	case <-time.After(2 * time.Second):
		t.Fatalf("webhook payload not received")
		return nil
	}
}

func waitIssueEventType(t *testing.T, st *store.Store, issueID int64, typ string) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		events, err := st.ListIssueEvents(context.Background(), issueID)
		if err != nil {
			t.Fatalf("list issue events: %v", err)
		}
		for _, event := range events {
			if event.Type == typ {
				return
			}
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("event %s not recorded for issue %d", typ, issueID)
}
