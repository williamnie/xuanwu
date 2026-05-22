package usage

import (
	"bytes"
	"encoding/json"
	"time"
)

type tokenEvent struct {
	Timestamp string `json:"timestamp"`
	Type      string `json:"type"`
	Payload   struct {
		Type       string      `json:"type"`
		Info       *tokenInfo  `json:"info"`
		RateLimits *RateLimits `json:"rate_limits"`
	} `json:"payload"`
}

type tokenInfo struct {
	TotalTokenUsage    TokenUsage `json:"total_token_usage"`
	LastTokenUsage     TokenUsage `json:"last_token_usage"`
	ModelContextWindow int64      `json:"model_context_window"`
}

var tokenCountMarker = []byte(`"type":"token_count"`)

func isTokenCountCandidate(line []byte) bool {
	return bytes.Contains(line, tokenCountMarker)
}

func parseTokenEvent(line []byte) (tokenEvent, bool) {
	if !isTokenCountCandidate(line) {
		return tokenEvent{}, false
	}
	var event tokenEvent
	if err := json.Unmarshal(line, &event); err != nil {
		return tokenEvent{}, false
	}
	return event, event.Type == "event_msg" && event.Payload.Type == "token_count"
}

func (e tokenEvent) timestamp() time.Time {
	ts, err := time.Parse(time.RFC3339Nano, e.Timestamp)
	if err != nil {
		return time.Time{}
	}
	return ts
}
