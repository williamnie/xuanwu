package runner

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/xiaobei/codex-issue-runner/backend/internal/agent"
	"github.com/xiaobei/codex-issue-runner/backend/internal/events"
	"github.com/xiaobei/codex-issue-runner/backend/internal/notifications"
	"github.com/xiaobei/codex-issue-runner/backend/internal/store"
)

func TestRunnerFailureSendsWebhookNotification(t *testing.T) {
	st := openRunnerStore(t)
	ctx := context.Background()
	payloads := make(chan map[string]any, 1)
	receiver := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var payload map[string]any
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Fatalf("decode webhook payload: %v", err)
		}
		payloads <- payload
		w.WriteHeader(http.StatusNoContent)
	}))
	defer receiver.Close()

	if _, err := st.SaveNotificationSettings(ctx, store.NotificationSettings{
		WebhookURL: receiver.URL,
		Events:     []string{store.StatusFailed},
	}); err != nil {
		t.Fatalf("save notification settings: %v", err)
	}
	_, _ = st.CreateProject(ctx, store.Project{ID: "demo", Name: "Demo", CWD: t.TempDir(), AutoRun: 1})
	issue, _ := st.CreateIssue(ctx, store.Issue{ProjectID: "demo", Title: "runner failure", Status: store.StatusTodo})
	fake := &fakeCodex{events: make(chan agent.Event, 4)}
	bus := events.NewBus()
	r := New(st, bus, fake)
	r.SetIssueNotifier(notifications.New(st, bus, nil))

	if err := r.StartProject("demo"); err != nil {
		t.Fatalf("start project: %v", err)
	}
	defer r.StopProject("demo")
	got := waitIssueStatus(t, st, issue.ID, store.StatusFailed)
	if got.Status != store.StatusFailed {
		t.Fatalf("issue = %+v, want failed", got)
	}

	select {
	case payload := <-payloads:
		if payload["event"] != "issue.failed" || payload["status"] != store.StatusFailed || payload["project"] != "demo" {
			t.Fatalf("unexpected webhook payload: %+v", payload)
		}
	case <-time.After(2 * time.Second):
		t.Fatalf("webhook payload not received")
	}
}
