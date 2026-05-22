package sessionwatch

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/xiaobei/codex-issue-runner/backend/internal/events"
)

func TestThreadIDFromPath(t *testing.T) {
	path := "/tmp/rollout-2026-05-22T12-09-06-019e4ddf-63d4-7530-a964-3dd183312ce1.jsonl"
	got := threadIDFromPath(path)
	want := "019e4ddf-63d4-7530-a964-3dd183312ce1"
	if got != want {
		t.Fatalf("threadIDFromPath()=%q want %q", got, want)
	}
}

func TestWatcherPublishesSessionEvents(t *testing.T) {
	root := t.TempDir()
	bus := events.NewBus()
	ch, unsubscribe := bus.Subscribe()
	defer unsubscribe()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	watcher := New(root, bus)
	if err := watcher.Start(ctx); err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	file := filepath.Join(root, "2026", "05", "22", "rollout-2026-05-22T12-09-06-019e4ddf-63d4-7530-a964-3dd183312ce1.jsonl")
	if err := os.MkdirAll(filepath.Dir(file), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(file, []byte("{}\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	event := waitForSessionEvent(t, ch)
	if event.ThreadID != "019e4ddf-63d4-7530-a964-3dd183312ce1" {
		t.Fatalf("unexpected event: %+v", event)
	}
	if event.Type != EventSessionCreated && event.Type != EventSessionUpdated {
		t.Fatalf("unexpected event type: %+v", event)
	}
}

func waitForSessionEvent(t *testing.T, ch <-chan events.AppEvent) events.AppEvent {
	t.Helper()
	timer := time.NewTimer(2 * time.Second)
	defer timer.Stop()
	for {
		select {
		case event := <-ch:
			if event.Type == EventSessionCreated || event.Type == EventSessionUpdated {
				return event
			}
		case <-timer.C:
			t.Fatal("timed out waiting for session event")
		}
	}
}
