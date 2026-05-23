package runner

import (
	"strings"
	"testing"
)

func TestIsRunnerHoldErrorClassifiesUsageAndAuthFailures(t *testing.T) {
	cases := []struct {
		name string
		text string
		kind string
	}{
		{
			name: "usage limit json",
			text: `API returned 429: {"error":{"type":"usage_limit_reached","message":"The usage limit has been reached","plan_type":"plus","resets_at":1779537806,"resets_in_seconds":14496}}`,
			kind: HoldReasonUsageLimit,
		},
		{
			name: "rate limit type",
			text: `{"error":{"type":"rate_limit_exceeded","message":"slow down"}}`,
			kind: HoldReasonUsageLimit,
		},
		{
			name: "unauthorized status",
			text: "API returned 401: 401 Unauthorized",
			kind: HoldReasonAuthentication,
		},
		{
			name: "refresh token",
			text: "Your access token could not be refreshed. Please sign in again.",
			kind: HoldReasonAuthentication,
		},
	}

	for _, tt := range cases {
		t.Run(tt.name, func(t *testing.T) {
			reason, ok := isRunnerHoldError(tt.text)
			if !ok {
				t.Fatalf("expected hold error for %q", tt.text)
			}
			if reason.Kind != tt.kind {
				t.Fatalf("kind = %q, want %q", reason.Kind, tt.kind)
			}
			if !strings.HasPrefix(reason.Message, "Runner paused: ") {
				t.Fatalf("message should be user-facing hold reason: %+v", reason)
			}
		})
	}
}

func TestIsRunnerHoldErrorIgnoresTaskFailures(t *testing.T) {
	cases := []string{
		"npm test failed with exit code 1",
		missingExplicitStatusMessage(),
		"Codex turn ended with status: failed",
		"需求不明确，请补充复现步骤",
	}
	for _, text := range cases {
		if reason, ok := isRunnerHoldError(text); ok {
			t.Fatalf("text %q should not hold runner, got %+v", text, reason)
		}
	}
}
