package usage

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestReadCodexUsageAggregatesTokenCountEvents(t *testing.T) {
	root := t.TempDir()
	writeJSONL(t, root, "2026/05/22/session.jsonl", []string{
		`{"timestamp":"2026-05-21T08:00:00Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":100,"cached_input_tokens":40,"output_tokens":20,"reasoning_output_tokens":5,"total_tokens":120},"last_token_usage":{"input_tokens":100,"cached_input_tokens":40,"output_tokens":20,"reasoning_output_tokens":5,"total_tokens":120},"model_context_window":258400},"rate_limits":{"limit_id":"codex","primary":{"used_percent":10,"window_minutes":300,"resets_at":1779361213},"secondary":{"used_percent":20,"window_minutes":10080,"resets_at":1779822011},"plan_type":"prolite"}}}`,
		`{"timestamp":"2026-05-22T08:00:00Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":300,"cached_input_tokens":60,"output_tokens":70,"reasoning_output_tokens":15,"total_tokens":370},"last_token_usage":{"input_tokens":200,"cached_input_tokens":20,"output_tokens":50,"reasoning_output_tokens":10,"total_tokens":250},"model_context_window":258400},"rate_limits":{"limit_id":"codex","primary":{"used_percent":25,"window_minutes":300,"resets_at":1779362213},"secondary":{"used_percent":50,"window_minutes":10080,"resets_at":1779823011},"plan_type":"prolite"}}}`,
	})
	writeJSONL(t, root, "2026/04/01/session.jsonl", []string{
		`{"timestamp":"2026-04-01T08:00:00Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"total_tokens":80},"last_token_usage":{"input_tokens":70,"output_tokens":10,"total_tokens":80}}}}`,
	})

	now := time.Date(2026, 5, 22, 12, 0, 0, 0, time.UTC)
	report, err := ReadCodexUsage(context.Background(), root, now)
	if err != nil {
		t.Fatalf("ReadCodexUsage error: %v", err)
	}
	assertTokens(t, "all time", report.Summary.AllTime.TotalTokens, 450)
	assertTokens(t, "today", report.Summary.Today.TotalTokens, 250)
	assertTokens(t, "this week", report.Summary.ThisWeek.TotalTokens, 370)
	assertTokens(t, "this month", report.Summary.ThisMonth.TotalTokens, 370)
	if report.EventsScanned != 3 || len(report.Daily) != 3 {
		t.Fatalf("unexpected events/daily: %+v", report)
	}
	if report.LatestUsage == nil || report.LatestUsage.LastTokenUsage.TotalTokens != 250 {
		t.Fatalf("latest usage not captured: %+v", report.LatestUsage)
	}
	if report.RateLimits == nil || report.RateLimits.Primary.RemainingPercent != 75 {
		t.Fatalf("rate limits not normalized: %+v", report.RateLimits)
	}
}

func TestReadSessionMetadataExtractsModelAndLatestTokenUsage(t *testing.T) {
	root := t.TempDir()
	writeJSONL(t, root, "session.jsonl", []string{
		`{"timestamp":"2026-05-22T08:00:00Z","type":"turn_context","payload":{"model":"gpt-5.5"}}`,
		`{"timestamp":"2026-05-22T08:01:00Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"total_tokens":120},"last_token_usage":{"input_tokens":100,"output_tokens":20,"total_tokens":120},"model_context_window":258400}}}`,
		`{"timestamp":"2026-05-22T08:02:00Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"total_tokens":180},"last_token_usage":{"input_tokens":50,"output_tokens":10,"total_tokens":60},"model_context_window":258400}}}`,
	})

	meta, err := ReadSessionMetadata(context.Background(), filepath.Join(root, "session.jsonl"))
	if err != nil {
		t.Fatalf("ReadSessionMetadata error: %v", err)
	}
	if meta.Model != "gpt-5.5" {
		t.Fatalf("model = %q, want gpt-5.5", meta.Model)
	}
	if meta.TokenUsage == nil || meta.TokenUsage.TotalTokenUsage.TotalTokens != 180 ||
		meta.TokenUsage.LastTokenUsage.TotalTokens != 60 {
		t.Fatalf("token usage not latest: %+v", meta.TokenUsage)
	}
}

func writeJSONL(t *testing.T, root, name string, lines []string) {
	t.Helper()
	path := filepath.Join(root, filepath.FromSlash(name))
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	body := ""
	for _, line := range lines {
		body += line + "\n"
	}
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatalf("write jsonl: %v", err)
	}
}

func assertTokens(t *testing.T, label string, got int64, want int64) {
	t.Helper()
	if got != want {
		t.Fatalf("%s tokens = %d, want %d", label, got, want)
	}
}
