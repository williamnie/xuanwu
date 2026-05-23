package codex

import (
	"encoding/json"
	"strings"
)

func SessionStatusIsRunning(raw json.RawMessage) bool {
	if len(raw) == 0 {
		return false
	}
	var status struct {
		Type   string `json:"type"`
		State  string `json:"state"`
		Status string `json:"status"`
	}
	if err := json.Unmarshal(raw, &status); err != nil {
		return false
	}
	for _, value := range []string{status.Type, status.State, status.Status} {
		switch normalizeStatusValue(value) {
		case "running", "inprogress", "in-progress", "streaming", "busy", "active":
			return true
		}
	}
	return false
}

func normalizeStatusValue(value string) string {
	value = strings.ToLower(strings.TrimSpace(value))
	return strings.ReplaceAll(value, "_", "-")
}
