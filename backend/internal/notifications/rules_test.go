package notifications

import (
	"testing"
	"time"

	"github.com/xiaobei/codex-issue-runner/backend/internal/store"
)

func TestShouldNotifyFiltersEvents(t *testing.T) {
	settings := store.NotificationSettings{
		WebhookURL: "http://127.0.0.1:8080/hook",
		Events:     []string{store.StatusDone},
	}
	now := time.Date(2026, 5, 23, 10, 30, 0, 0, time.Local)

	if !ShouldNotify(settings, store.StatusDone, now) {
		t.Fatalf("done should notify when selected")
	}
	if ShouldNotify(settings, store.StatusFailed, now) {
		t.Fatalf("failed should not notify when not selected")
	}
	settings.WebhookURL = ""
	if ShouldNotify(settings, store.StatusDone, now) {
		t.Fatalf("empty webhook url should disable webhook notification")
	}
}

func TestShouldNotifyRespectsActiveHours(t *testing.T) {
	settings := store.NotificationSettings{
		WebhookURL:  "http://127.0.0.1:8080/hook",
		Events:      []string{store.StatusDone, store.StatusFailed},
		ActiveStart: "09:00",
		ActiveEnd:   "17:30",
	}

	if !ShouldNotify(settings, store.StatusDone, atClock("12:00")) {
		t.Fatalf("midday should be inside active hours")
	}
	if ShouldNotify(settings, store.StatusDone, atClock("08:59")) {
		t.Fatalf("before active hours should be quiet")
	}
	if ShouldNotify(settings, store.StatusFailed, atClock("17:31")) {
		t.Fatalf("after active hours should be quiet")
	}
}

func TestShouldNotifyRespectsOvernightActiveHours(t *testing.T) {
	settings := store.NotificationSettings{
		WebhookURL:  "http://127.0.0.1:8080/hook",
		Events:      []string{store.StatusFailed},
		ActiveStart: "22:00",
		ActiveEnd:   "07:00",
	}

	if !ShouldNotify(settings, store.StatusFailed, atClock("23:30")) {
		t.Fatalf("late night should be inside overnight active hours")
	}
	if !ShouldNotify(settings, store.StatusFailed, atClock("06:30")) {
		t.Fatalf("early morning should be inside overnight active hours")
	}
	if ShouldNotify(settings, store.StatusFailed, atClock("12:00")) {
		t.Fatalf("midday should be quiet for overnight active hours")
	}
}

func atClock(value string) time.Time {
	parsed, err := time.Parse("15:04", value)
	if err != nil {
		panic(err)
	}
	return time.Date(2026, 5, 23, parsed.Hour(), parsed.Minute(), 0, 0, time.Local)
}
