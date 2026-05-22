package codex

import (
	"encoding/json"
	"testing"
)

func TestSessionStatusIsRunning(t *testing.T) {
	cases := []struct {
		name string
		raw  json.RawMessage
		want bool
	}{
		{name: "running type", raw: json.RawMessage(`{"type":"running"}`), want: true},
		{name: "in progress state", raw: json.RawMessage(`{"state":"inProgress"}`), want: true},
		{name: "idle", raw: json.RawMessage(`{"type":"idle"}`), want: false},
		{name: "not loaded", raw: json.RawMessage(`{"type":"notLoaded"}`), want: false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := SessionStatusIsRunning(tc.raw); got != tc.want {
				t.Fatalf("SessionStatusIsRunning(%s) = %v, want %v", tc.raw, got, tc.want)
			}
		})
	}
}
